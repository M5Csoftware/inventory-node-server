import mongoose from "mongoose";
import Product from "./models/Product.js";
import Transaction from "./models/Transaction.js";
import Category from "./models/Category.js";
import Supplier from "./models/Supplier.js";
import User from "./models/User.js";
import Order from "./models/Order.js";
import AssetAssignment from "./models/AssetAssignment.js";
import Maintenance from "./models/Maintenance.js";
import AssetSerial from "./models/AssetSerial.js";
import AuditLog from "./models/AuditLog.js";
import Invoice from "../invoice-registration/models/Invoice.js";
import jwt from "jsonwebtoken";

const inventorySettingsSchema = new mongoose.Schema(
  {
    revertPassword: { type: String, default: "admin123" },
    defaultThreshold: { type: Number, default: 10 },
    currency: { type: String, default: "INR" },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

const InventorySettings = (dbName) => {
  const targetDbName = dbName || "m5c-inventory";
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return (
    db.models.InventorySettings ||
    db.model("InventorySettings", inventorySettingsSchema)
  );
};

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";

// Helper to extract user identity from JWT or request context
const getUserFromRequest = async (request, dbName) => {
  try {
    const authHeader =
      request?.headers?.["authorization"] ||
      request?.headers?.["Authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded) {
        if (
          decoded.id === "master" ||
          (decoded.email && decoded.email.toLowerCase().includes("master"))
        ) {
          return {
            userName: "Master Admin",
            userEmail: decoded.email || "master@m5clogs.com",
            userRole: "Master Admin",
            branch: decoded.branch || "All",
          };
        }
        if (decoded.name) {
          return {
            userName: decoded.name,
            userEmail: decoded.email || "",
            userRole: decoded.role || "User",
            branch: decoded.branch || "Global",
          };
        }
        const userModel = User(dbName);
        const userObj = await userModel
          .findOne({
            $or: [
              ...(decoded.id ? [{ id: decoded.id }] : []),
              ...(decoded.email
                ? [{ email: decoded.email.toLowerCase().trim() }]
                : []),
            ],
          })
          .lean();
        if (userObj) {
          return {
            userName: userObj.name || decoded.email || "System User",
            userEmail: userObj.email || decoded.email || "",
            userRole: userObj.role || decoded.role || "User",
            branch: userObj.branch || decoded.branch || "Global",
          };
        }
        return {
          userName: decoded.email || "System User",
          userEmail: decoded.email || "",
          userRole: decoded.role || "User",
          branch: decoded.branch || "Global",
        };
      }
    }
  } catch (err) {
    // ignore jwt decoding error
  }

  // Fallback to request body if user info is passed
  if (request?.body?.userName || request?.body?.userEmail) {
    return {
      userName: request.body.userName || "System User",
      userEmail: request.body.userEmail || "",
      userRole: request.body.userRole || "User",
      branch: request.body.branch || "Global",
    };
  }

  // Fallback to default user in DB
  try {
    const users = await User(dbName).find().lean();
    const defaultUser =
      users.find((u) => u.name) || (users.length > 0 ? users[0] : null);
    if (defaultUser) {
      return {
        userName: defaultUser.name,
        userEmail: defaultUser.email,
        userRole: defaultUser.role,
        branch: defaultUser.branch || "Global",
      };
    }
  } catch (e) {}

  return {
    userName: "Master Admin",
    userEmail: "master@m5clogs.com",
    userRole: "Admin",
    branch: "Global",
  };
};

// Helper function to create audit log entries in backend
const createAuditLog = async (dbName, logData, request = null) => {
  try {
    const auditModel = AuditLog(dbName);
    let userDetails = {
      userName: logData.userName,
      userEmail: logData.userEmail,
      userRole: logData.userRole,
      branch: logData.branch,
    };

    if (
      request &&
      (!userDetails.userName || userDetails.userName === "System User")
    ) {
      const extracted = await getUserFromRequest(request, dbName);
      userDetails = {
        userName: logData.userName || extracted.userName,
        userEmail: logData.userEmail || extracted.userEmail,
        userRole: logData.userRole || extracted.userRole,
        branch: logData.branch || extracted.branch,
      };
    }

    const ipAddress =
      request?.headers?.["x-forwarded-for"] ||
      request?.ip ||
      request?.socket?.remoteAddress ||
      logData.ipAddress ||
      "127.0.0.1";

    // Compute next unique LOG-XXXX ID
    const count = await auditModel.countDocuments();
    const lastLog = await auditModel
      .findOne({ id: /^LOG-/ })
      .sort({ _id: -1 })
      .lean();
    let nextNum = count + 1001;
    if (lastLog && lastLog.id) {
      const parsed = parseInt(lastLog.id.replace("LOG-", ""), 10);
      if (!isNaN(parsed) && parsed >= nextNum) {
        nextNum = parsed + 1;
      }
    }
    const nextId = `LOG-${nextNum}`;

    const created = await auditModel.create({
      id: nextId,
      userName: userDetails.userName || "Master Admin",
      userEmail: userDetails.userEmail || "",
      userRole: userDetails.userRole || "Admin",
      action: logData.action,
      category: logData.category,
      details: logData.details,
      target: logData.target || "",
      branch: logData.branch || userDetails.branch || "Global",
      ipAddress: String(ipAddress).split(",")[0].trim(),
      referenceId: logData.referenceId || "",
      entityType: logData.entityType || "",
      previousState: logData.previousState || null,
      newState: logData.newState || null,
      isReverted: false,
      timestamp: logData.timestamp || new Date(),
    });

    return created;
  } catch (err) {
    console.error("Failed to create audit log entry:", err);
    return null;
  }
};

// ── HELPER FUNCTIONS ──

// Extracts a supplier name for a product/branch from its Stock In transactions.
// Looks first at a dedicated `supplier` field on the transaction (if present),
// then falls back to parsing "Supplier: X" out of reasonOrLocation/notes/reason,
// then falls back to the product's own supplier fields.
const extractSupplierName = (branchTxs, prod) => {
  const stockInTxs = branchTxs.filter((t) => t.type === "Stock In");

  if (stockInTxs.length > 0) {
    const sorted = [...stockInTxs].sort(
      (a, b) =>
        new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt),
    );

    for (const t of sorted) {
      if (t.supplier && typeof t.supplier === "string" && t.supplier.trim()) {
        return t.supplier.trim();
      }
      const combinedNotes = `${t.reasonOrLocation || ""} ${t.notes || ""} ${t.reason || ""}`;
      const match = combinedNotes.match(/Supplier:\s*([^|]+)/i);
      if (match && match[1] && match[1].trim()) {
        return match[1].trim();
      }
    }
  }

  return (
    prod.supplier ||
    (prod.suppliersList && prod.suppliersList.length > 0
      ? prod.suppliersList[0]?.supplierName
      : null) ||
    "-"
  );
};

// Looks up the cost rate saved for a specific supplier on a product's
// suppliersList (set via the product edit page's "Suppliers & Cost Rates"
// section). Falls back to the product's primary `price` field if the
// supplier isn't found in the list, or if no suppliersList exists.
const getSupplierRate = (prod, supplierName) => {
  if (prod.suppliersList && Array.isArray(prod.suppliersList) && supplierName) {
    const match = prod.suppliersList.find(
      (s) =>
        s.supplierName &&
        s.supplierName.toLowerCase() === supplierName.toLowerCase(),
    );
    if (
      match &&
      match.rate !== undefined &&
      match.rate !== null &&
      !isNaN(Number(match.rate))
    ) {
      return Number(match.rate);
    }
  }
  return Number(prod.price) || 0;
};

// Extracts the "Amount / Price" entered on the Stock In form from a product/branch's
// most recent Stock In transaction. This is used directly as the Purchase Value
// (not multiplied by opening stock) since it's the actual amount paid on intake.
// Looks first at a dedicated `amount`/`price` field on the transaction (if present),
// then falls back to parsing "Price: ₹X" out of reasonOrLocation/notes/reason.
// Returns null if no such amount was ever recorded.
const extractPurchaseAmount = (branchTxs) => {
  const stockInTxs = branchTxs.filter((t) => t.type === "Stock In");

  if (stockInTxs.length > 0) {
    const sorted = [...stockInTxs].sort(
      (a, b) =>
        new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt),
    );

    for (const t of sorted) {
      if (
        t.amount !== undefined &&
        t.amount !== null &&
        !isNaN(Number(t.amount))
      ) {
        return Number(t.amount);
      }
      if (
        t.price !== undefined &&
        t.price !== null &&
        !isNaN(Number(t.price))
      ) {
        return Number(t.price);
      }
      const combinedNotes = `${t.reasonOrLocation || ""} ${t.notes || ""} ${t.reason || ""}`;
      const match = combinedNotes.match(/Price:\s*₹?\s*([\d,]+(?:\.\d+)?)/i);
      if (match && match[1]) {
        const parsed = Number(match[1].replace(/,/g, ""));
        if (!isNaN(parsed)) return parsed;
      }
    }
  }

  return null;
};

// Gets the last purchase date from the most recent Stock In transaction
const getLastPurchaseDate = (branchTxs) => {
  const stockInTxs = branchTxs.filter((t) => t.type === "Stock In");
  let lastPurchaseDate = "-";

  if (stockInTxs.length > 0) {
    // Sort by purchaseDate first, then date, then createdAt
    const sorted = [...stockInTxs].sort((a, b) => {
      const dateA = a.purchaseDate || a.date || a.createdAt;
      const dateB = b.purchaseDate || b.date || b.createdAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    const latestTx = sorted[0];
    const dateToUse =
      latestTx.purchaseDate || latestTx.date || latestTx.createdAt;

    if (dateToUse) {
      const d = new Date(dateToUse);
      // Only format if it's a valid date
      if (!isNaN(d.getTime())) {
        lastPurchaseDate = d.toLocaleDateString("en-IN", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
    }
  }

  return lastPurchaseDate;
};

export default async function inventoryRoutes(fastify, options) {
  const getDbName = (request) => request.headers["x-database"];

  // ── AUTH ──
  fastify.post("/auth/login", async (request, reply) => {
    const dbName = getDbName(request);
    const { email, password } = request.body;

    if (!email || !password) {
      return reply
        .status(400)
        .send({ success: false, message: "Email and password are required" });
    }

    try {
      // Check Master Admin
      const masterAdminEmail =
        process.env.INVENTORY_MANAGEMENT_MASTER_ADMIN_EMAIL ||
        process.env.INVENTORY_MASTER_ADMIN_EMAIL ||
        process.env.MASTER_ADMIN_EMAIL;
      const masterAdminPassword =
        process.env.INVENTORY_MANAGEMENT_MASTER_ADMIN_PASSWORD ||
        process.env.INVENTORY_MASTER_ADMIN_PASSWORD ||
        process.env.MASTER_ADMIN_PASSWORD;

      if (
        masterAdminEmail &&
        email.toLowerCase().trim() === masterAdminEmail.toLowerCase() &&
        password === masterAdminPassword
      ) {
        const token = jwt.sign(
          {
            id: "master",
            email: masterAdminEmail,
            role: "admin",
            branch: "All",
            dbName: dbName || "m5c-inventory",
          },
          JWT_SECRET,
          { expiresIn: "8h" },
        );
        return {
          success: true,
          data: {
            token,
            user: {
              id: "master",
              name: "Master Admin",
              email: masterAdminEmail,
              role: "admin",
              branch: "All",
              permissions: ["*"],
            },
          },
        };
      }

      const userModel = User(dbName);
      const user = await userModel
        .findOne({ email: email.toLowerCase().trim() })
        .select("+password");
      if (!user) {
        return reply
          .status(401)
          .send({ success: false, message: "Invalid email or password" });
      }

      const isMatch = user.comparePassword(password);
      if (!isMatch) {
        return reply
          .status(401)
          .send({ success: false, message: "Invalid email or password" });
      }

      user.lastLogin = new Date();
      await user.save();

      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          branch: user.branch,
          dbName: dbName || "m5c-inventory",
        },
        JWT_SECRET,
        { expiresIn: "8h" },
      );

      return {
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            branch: user.branch,
            permissions: user.permissions || [],
          },
        },
      };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  const getNextUserId = async (dbName) => {
    const userModel = User(dbName);
    const users = await userModel.find({}, { id: 1 }).lean();
    let maxNum = 0;
    for (const u of users) {
      if (u.id && typeof u.id === "string" && u.id.startsWith("USER-")) {
        const num = parseInt(u.id.replace("USER-", ""), 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
    return `USER-${String(maxNum + 1).padStart(3, "0")}`;
  };

  fastify.post("/auth/signup", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const userModel = User(dbName);
      const nextId = await getNextUserId(dbName);
      const created = await userModel.create({ ...request.body, id: nextId });

      await createAuditLog(
        dbName,
        {
          userName: created.name,
          userEmail: created.email,
          userRole: created.role,
          action: "User Account Created",
          category: "Users",
          details: `Signed up new user account for ${created.name} (${created.email}) with role ${created.role}`,
          target: created.name,
          branch: created.branch || "Global",
          referenceId: created.id,
        },
        request,
      );

      return {
        success: true,
        data: {
          id: created.id,
          name: created.name,
          email: created.email,
          role: created.role,
          branch: created.branch,
        },
      };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.get("/auth/me", async (request, reply) => {
    const authHeader = request.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply
        .status(401)
        .send({ success: false, message: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return { success: true, data: decoded };
    } catch (error) {
      return reply
        .status(401)
        .send({ success: false, message: "Invalid or expired token" });
    }
  });

  // ── USERS ──
  fastify.get("/users", async (request, reply) => {
    const dbName = getDbName(request);
    const list = await User(dbName).find().sort({ createdAt: -1 }).lean();

    // Deduplicate any duplicate or missing user IDs in DB
    const seen = new Set();
    let maxNum = 0;
    for (const u of list) {
      if (u.id && typeof u.id === "string" && u.id.startsWith("USER-")) {
        const num = parseInt(u.id.replace("USER-", ""), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    }

    for (const u of list) {
      if (!u.id || seen.has(u.id)) {
        maxNum++;
        const newId = `USER-${String(maxNum).padStart(3, "0")}`;
        await User(dbName).updateOne({ _id: u._id }, { $set: { id: newId } });
        u.id = newId;
        seen.add(newId);
      } else {
        seen.add(u.id);
      }
    }

    return { success: true, data: list };
  });

  fastify.get("/users/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    const targetUser = await User(dbName).findOne({ id });
    if (!targetUser) {
      return reply
        .status(404)
        .send({ success: false, message: "User not found" });
    }
    return { success: true, data: targetUser };
  });

  fastify.post("/users", async (request, reply) => {
    const dbName = getDbName(request);
    const { name, email, password, role, branch, permissions } = request.body;

    if (role === "master") {
      return reply
        .status(403)
        .send({ success: false, message: "Cannot create master role" });
    }

    if (!password) {
      return reply
        .status(400)
        .send({ success: false, message: "Password is required to create a new user account" });
    }

    try {
      const nextId = await getNextUserId(dbName);
      const created = await User(dbName).create({
        id: nextId,
        name,
        email,
        password,
        role,
        branch,
        permissions: permissions || [],
      });

      await createAuditLog(
        dbName,
        {
          action: "User Account Created",
          category: "Users",
          details: `Created user account for ${created.name} (${created.email}) with role ${created.role} in branch ${created.branch || "Global"}`,
          target: created.name,
          branch: created.branch || "Global",
          referenceId: created.id,
        },
        request,
      );

      return {
        success: true,
        data: {
          id: created.id,
          name: created.name,
          email: created.email,
          role: created.role,
          branch: created.branch,
          permissions: created.permissions,
        },
      };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/users/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    const { name, email, password, role, branch, permissions } = request.body;

    if (id === "master" || role === "master") {
      return reply
        .status(403)
        .send({ success: false, message: "Cannot modify master role" });
    }

    try {
      const updateData = { name, email, role, branch };
      if (password) updateData.password = password;
      if (Array.isArray(permissions)) updateData.permissions = permissions;

      const updated = await User(dbName).findOneAndUpdate({ id }, updateData, {
        new: true,
      });
      if (!updated)
        return reply
          .status(404)
          .send({ success: false, message: "User not found" });

      await createAuditLog(
        dbName,
        {
          action: "User Account Updated",
          category: "Users",
          details: `Updated user account ${updated.name} (${updated.email}, Role: ${updated.role}, Branch: ${updated.branch || "Global"})`,
          target: updated.name,
          branch: updated.branch || "Global",
          referenceId: updated.id,
        },
        request,
      );

      return {
        success: true,
        data: {
          id: updated.id,
          name: updated.name,
          email: updated.email,
          role: updated.role,
          branch: updated.branch,
          permissions: updated.permissions,
        },
      };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/users/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;

    if (!id || id === "master") {
      return reply
        .status(403)
        .send({ success: false, message: "Cannot delete master role" });
    }

    try {
      const userModel = User(dbName);
      let deleted = await userModel.findOneAndDelete({ id });

      if (!deleted && /^[0-9a-fA-F]{24}$/.test(id)) {
        deleted = await userModel.findByIdAndDelete(id);
      }

      if (!deleted) {
        return reply
          .status(404)
          .send({ success: false, message: "User not found" });
      }

      await createAuditLog(
        dbName,
        {
          action: "User Account Deleted",
          category: "Users",
          details: `Deleted user account ${deleted?.name || id} (${deleted?.email || ""})`,
          target: deleted?.name || id,
          branch: deleted?.branch || "Global",
          referenceId: id,
        },
        request,
      );

      return { success: true, message: "User deleted successfully" };
    } catch (error) {
      console.error("Delete user route error:", error);
      return reply.status(500).send({ success: false, message: error.message });
    }
  });

  // ── AUDIT LOGS ──
  fastify.get("/audit-logs", async (request, reply) => {
    const dbName = getDbName(request);
    const { branch, category, search, startDate, endDate } = request.query;

    try {
      const auditLogModel = AuditLog(dbName);
      let logs = await auditLogModel.find().lean();
      const users = await User(dbName).find().lean();
      const defaultUser =
        users.find((u) => u.name) || (users.length > 0 ? users[0] : null);
      const defaultUserName = defaultUser ? defaultUser.name : "Master Admin";
      const defaultUserEmail = defaultUser ? defaultUser.email : "master@m5clogs.com";
      const defaultUserRole = defaultUser ? defaultUser.role : "Admin";

      // 1. Reconcile missing historical records into AuditLog collection
      const txs = await Transaction(dbName).find().lean();
      const prods = await Product(dbName).find().lean();
      const orders = await Order(dbName).find().lean();
      const assetAssignments = await AssetAssignment(dbName).find().lean();

      // Find max existing LOG-xxxx number
      let maxLogNum = 1000;
      for (const l of logs) {
        if (l.id && typeof l.id === "string" && l.id.startsWith("LOG-")) {
          const num = parseInt(l.id.replace("LOG-", ""), 10);
          if (!isNaN(num) && num > maxLogNum) maxLogNum = num;
        }
      }

      const newLogsToInsert = [];

      // Check transactions
      for (const t of txs) {
        const isLogged = logs.some((l) => {
          if (l.referenceId && l.referenceId === t.id) return true;
          if (l.details && t.id && l.details.includes(t.id)) return true;
          const tTime = new Date(t.date || t.createdAt || 0).getTime();
          const lTime = new Date(l.timestamp || l.createdAt || 0).getTime();
          const isSameTarget =
            l.target === t.productName || l.details?.includes(t.productName);
          const isSameAction =
            (t.type === "Stock In" && l.action === "Stock In") ||
            (t.type === "Stock Out" && l.action === "Stock Out") ||
            l.action === "Stock Transfer";
          const isSameBranch =
            l.branch === t.branch ||
            l.branch === "Global" ||
            (l.branch && l.branch.includes(t.branch || ""));
          return (
            isSameTarget &&
            isSameAction &&
            isSameBranch &&
            Math.abs(tTime - lTime) < 10000
          );
        });

        if (!isLogged) {
          maxLogNum++;
          const act =
            t.type === "Stock In"
              ? "Stock In"
              : t.type === "Stock Out"
                ? "Stock Out"
                : "Stock Transfer";
          let detailsText = `${t.type} of ${t.quantity} units for product ${t.productName}`;
          if (t.reasonOrLocation) detailsText += ` [Reason: ${t.reasonOrLocation}]`;
          if (t.notes) detailsText += ` (${t.notes})`;
          if (t.supplier) detailsText += ` [Supplier: ${t.supplier}]`;
          if (t.invoiceNumber) detailsText += ` [Invoice: ${t.invoiceNumber}]`;

          const newLog = {
            id: `LOG-${maxLogNum}`,
            userName: defaultUserName,
            userEmail: defaultUserEmail,
            userRole: defaultUserRole,
            action: act,
            category: "Stock",
            details: detailsText,
            target: t.productName,
            branch: t.branch || "Ahmedabad",
            ipAddress: "192.168.1.50",
            referenceId: t.id || "",
            timestamp: t.date ? new Date(t.date) : t.createdAt || new Date(),
          };
          newLogsToInsert.push(newLog);
          logs.push(newLog);
        }
      }

      // Check users
      for (const u of users) {
        const isLogged = logs.some((l) => {
          if (l.referenceId && l.referenceId === u.id) return true;
          return (
            l.category === "Users" &&
            (l.userEmail === u.email || l.target === u.name)
          );
        });

        if (!isLogged) {
          maxLogNum++;
          const newLog = {
            id: `LOG-${maxLogNum}`,
            userName: u.name || defaultUserName,
            userEmail: u.email || defaultUserEmail,
            userRole: u.role || defaultUserRole,
            action: "User Account Created",
            category: "Users",
            details: `Created user account for ${u.name} (${u.email}) with role ${u.role}`,
            target: u.name,
            branch: u.branch || "Global",
            ipAddress: "127.0.0.1",
            referenceId: u.id || "",
            timestamp: u.createdAt || new Date(),
          };
          newLogsToInsert.push(newLog);
          logs.push(newLog);
        }
      }

      // Check products
      for (const p of prods) {
        const isLogged = logs.some((l) => {
          if (l.referenceId && l.referenceId === p.id) return true;
          return (
            l.category === "Products" &&
            (l.target === p.name || (l.details && l.details.includes(p.id)))
          );
        });

        if (!isLogged) {
          maxLogNum++;
          const newLog = {
            id: `LOG-${maxLogNum}`,
            userName: defaultUserName,
            userEmail: defaultUserEmail,
            userRole: defaultUserRole,
            action: "Product Created",
            category: "Products",
            details: `Registered product ${p.name} (SKU: ${p.id}) under category ${p.category || "General"}`,
            target: p.name,
            branch: "Global",
            ipAddress: "127.0.0.1",
            referenceId: p.id || "",
            timestamp: p.createdAt || new Date(),
          };
          newLogsToInsert.push(newLog);
          logs.push(newLog);
        }
      }

      // Check orders
      for (const o of orders) {
        const isLogged = logs.some((l) => {
          if (l.referenceId && l.referenceId === o.id) return true;
          return l.category === "Orders" && l.details && l.details.includes(o.id);
        });

        if (!isLogged) {
          maxLogNum++;
          const newLog = {
            id: `LOG-${maxLogNum}`,
            userName: defaultUserName,
            userEmail: defaultUserEmail,
            userRole: defaultUserRole,
            action: "Order Created",
            category: "Orders",
            details: `Created order ${o.id} for supplier ${o.supplier || "N/A"} (${(o.items || []).length} items, Status: ${o.status || "Pending"})`,
            target: o.supplier || o.id,
            branch: o.branch || "Global",
            ipAddress: "127.0.0.1",
            referenceId: o.id || "",
            timestamp: o.createdAt || new Date(),
          };
          newLogsToInsert.push(newLog);
          logs.push(newLog);
        }
      }

      // Check asset assignments
      for (const a of assetAssignments) {
        const isLogged = logs.some((l) => {
          if (l.referenceId && l.referenceId === a.id) return true;
          return l.category === "Assets" && l.details && l.details.includes(a.id);
        });

        if (!isLogged) {
          maxLogNum++;
          const newLog = {
            id: `LOG-${maxLogNum}`,
            userName: defaultUserName,
            userEmail: defaultUserEmail,
            userRole: defaultUserRole,
            action: "Asset Assigned",
            category: "Assets",
            details: `Assigned asset ${a.productName || a.productId} to ${a.assignedTo || "Employee"} in branch ${a.branch || "Ahmedabad"}${a.serialNumber ? ` [Serial: ${a.serialNumber}]` : ""}`,
            target: a.productName || a.assignedTo,
            branch: a.branch || "Ahmedabad",
            ipAddress: "127.0.0.1",
            referenceId: a.id || "",
            timestamp: a.assignedDate
              ? new Date(a.assignedDate)
              : a.createdAt || new Date(),
          };
          newLogsToInsert.push(newLog);
          logs.push(newLog);
        }
      }

      // Check Invoices from m5-invoice-registration
      try {
        const invoices = await Invoice().find().lean();
        for (const inv of invoices) {
          const isLogged = logs.some((l) => {
            if (l.referenceId && l.referenceId === inv.id) return true;
            return (
              l.category === "Invoice" &&
              (l.target === inv.invoiceNumber ||
                (l.details && l.details.includes(inv.invoiceNumber)))
            );
          });

          if (!isLogged) {
            maxLogNum++;
            const newLog = {
              id: `LOG-${maxLogNum}`,
              userName: inv.enteredBy || defaultUserName,
              userEmail: defaultUserEmail,
              userRole: defaultUserRole,
              action: "Invoice Uploaded",
              category: "Invoice",
              details: `Uploaded inward invoice #${inv.invoiceNumber} from vendor "${inv.vendor}" (Total: ₹${(inv.amount || 0).toLocaleString("en-IN")}, Status: ${inv.status || "pending_verification"})`,
              target: inv.invoiceNumber || inv.id,
              branch: inv.branch || "Delhi",
              ipAddress: "127.0.0.1",
              referenceId: inv.id || "",
              entityType: "Invoice",
              newState: inv,
              timestamp: inv.createdAt
                ? new Date(inv.createdAt)
                : inv.enteredAt
                ? new Date(inv.enteredAt)
                : new Date(),
            };
            newLogsToInsert.push(newLog);
            logs.push(newLog);
          }
        }
      } catch (err) {
        console.error("Invoice audit log reconciliation error:", err);
      }

      // Persist any newly reconciled logs to DB
      if (newLogsToInsert.length > 0) {
        await auditLogModel.insertMany(newLogsToInsert);
      }

      // Heal user names on existing logs if matched
      for (const l of logs) {
        const matchedUser = users.find(
          (u) =>
            u.email &&
            u.email.toLowerCase() === (l.userEmail || "").toLowerCase(),
        );
        if (matchedUser && matchedUser.name && l.userName !== matchedUser.name) {
          if (l._id) {
            await auditLogModel.updateOne(
              { _id: l._id },
              { $set: { userName: matchedUser.name } },
            );
          }
          l.userName = matchedUser.name;
        } else if (
          l.userName === "Stock Manager" ||
          l.userName === "Master Admin" ||
          !l.userName
        ) {
          const newName = defaultUserName;
          if (l._id) {
            await auditLogModel.updateOne(
              { _id: l._id },
              { $set: { userName: newName } },
            );
          }
          l.userName = newName;
        }
      }

      // Apply Filter conditions
      let filtered = logs;

      if (branch && branch !== "All") {
        filtered = filtered.filter(
          (l) =>
            l.branch === branch ||
            l.branch === "Global" ||
            (l.branch && l.branch.includes(branch)),
        );
      }

      if (category && category !== "All") {
        filtered = filtered.filter((l) => l.category === category);
      }

      if (search && search.trim()) {
        const q = search.toLowerCase().trim();
        filtered = filtered.filter(
          (l) =>
            (l.userName && l.userName.toLowerCase().includes(q)) ||
            (l.userEmail && l.userEmail.toLowerCase().includes(q)) ||
            (l.action && l.action.toLowerCase().includes(q)) ||
            (l.details && l.details.toLowerCase().includes(q)) ||
            (l.target && l.target.toLowerCase().includes(q)) ||
            (l.id && l.id.toLowerCase().includes(q)),
        );
      }

      if (startDate) {
        const sTime = new Date(startDate).getTime();
        filtered = filtered.filter(
          (l) => new Date(l.timestamp || l.createdAt).getTime() >= sTime,
        );
      }

      if (endDate) {
        const eTime = new Date(endDate).setHours(23, 59, 59, 999);
        filtered = filtered.filter(
          (l) => new Date(l.timestamp || l.createdAt).getTime() <= eTime,
        );
      }

      filtered.sort(
        (a, b) =>
          new Date(b.timestamp || b.createdAt).getTime() -
          new Date(a.timestamp || a.createdAt).getTime(),
      );

      return { success: true, count: filtered.length, data: filtered };
    } catch (error) {
      console.error("GET /audit-logs error:", error);
      return reply
        .status(500)
        .send({ success: false, message: error.message });
    }
  });

  fastify.post("/audit-logs", async (request, reply) => {
    const dbName = getDbName(request);
    const {
      userName,
      userEmail,
      userRole,
      action,
      category,
      details,
      target,
      branch,
      referenceId,
    } = request.body;

    try {
      const created = await createAuditLog(
        dbName,
        {
          userName,
          userEmail,
          userRole,
          action,
          category,
          details,
          target,
          branch,
          referenceId,
        },
        request,
      );
      return { success: true, data: created };
    } catch (error) {
      return reply
        .status(400)
        .send({ success: false, message: error.message });
    }
  });

  fastify.get("/settings/security", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const settingsModel = InventorySettings(dbName);
      let settings = await settingsModel.findOne();
      if (!settings) {
        settings = await settingsModel.create({ revertPassword: "admin123" });
      }
      return {
        success: true,
        data: {
          isPasswordSet: !!settings.revertPassword,
          hasCustomPassword: settings.revertPassword !== "admin123",
          updatedAt: settings.updatedAt,
          updatedBy: settings.updatedBy || "System Default",
        },
      };
    } catch (error) {
      return reply.status(500).send({ success: false, message: error.message });
    }
  });

  fastify.put("/settings/revert-password", async (request, reply) => {
    const dbName = getDbName(request);
    const { currentPassword, newPassword } = request.body || {};

    try {
      const currentUser = await getUserFromRequest(request, dbName);
      const role = (currentUser.userRole || "").toLowerCase();
      const isAdmin =
        role === "admin" ||
        role === "master" ||
        role === "master admin" ||
        role === "system administrator";

      if (!isAdmin) {
        return reply.status(403).send({
          success: false,
          message: "Only Admins and Master Admin can configure the rollback password.",
        });
      }

      if (!newPassword || newPassword.trim().length < 4) {
        return reply.status(400).send({
          success: false,
          message: "New rollback password must be at least 4 characters long.",
        });
      }

      const settingsModel = InventorySettings(dbName);
      let settings = await settingsModel.findOne();
      if (!settings) {
        settings = await settingsModel.create({ revertPassword: "admin123" });
      }

      // Check current password if already customized
      if (settings.revertPassword && settings.revertPassword !== "admin123") {
        if (!currentPassword || currentPassword.trim() !== settings.revertPassword.trim()) {
          return reply.status(401).send({
            success: false,
            message: "Current rollback password is incorrect.",
          });
        }
      }

      settings.revertPassword = newPassword.trim();
      settings.updatedBy = currentUser.userName;
      await settings.save();

      await createAuditLog(
        dbName,
        {
          action: "Revert Password Updated",
          category: "System",
          details: `Updated security password for action rollback and undo operations`,
          target: "System Security",
          branch: "Global",
        },
        request
      );

      return {
        success: true,
        message: "Rollback security password successfully updated!",
      };
    } catch (error) {
      return reply.status(500).send({ success: false, message: error.message });
    }
  });

  fastify.post("/audit-logs/:id/revert", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    const { reason, password } = request.body || {};

    try {
      // Rollback Security Check
      const settingsModel = InventorySettings(dbName);
      let settings = await settingsModel.findOne();
      if (!settings) {
        settings = await settingsModel.create({ revertPassword: "admin123" });
      }
      const requiredPassword = settings.revertPassword || "admin123";

      if (!password || password.trim() !== requiredPassword.trim()) {
        return reply.status(401).send({
          success: false,
          message: "Incorrect rollback authorization password. Access denied.",
        });
      }

      const auditModel = AuditLog(dbName);
      const log = await auditModel.findOne({ id }).lean();
      if (!log) {
        return reply
          .status(404)
          .send({ success: false, message: "Audit log record not found" });
      }
      if (log.isReverted) {
        return reply.status(400).send({
          success: false,
          message: "This operation has already been reverted.",
        });
      }

      const currentUser = await getUserFromRequest(request, dbName);
      const action = log.action;
      const entityType = log.entityType || "";
      const refId = log.referenceId || log.target;
      let rollbackSuccess = false;
      let rollbackDetails = "";

      // 1. Transactions (Stock In, Stock Out, Stock Adjust)
      if (
        action === "Stock In" ||
        action === "Stock Out" ||
        action === "Stock Adjust" ||
        entityType === "Transaction"
      ) {
        const tx =
          (await Transaction(dbName).findOne({ id: refId }).lean()) ||
          log.newState?.transaction ||
          log.newState;
        const prodId = tx?.productId || log.target;
        const qty = Number(tx?.quantity || 0);
        const branchName = tx?.branch || log.branch || "Delhi";

        if (action === "Stock In") {
          // Reverting Stock In -> Decrease stock by qty
          if (prodId && qty > 0) {
            const product = await Product(dbName).findOne({ id: prodId });
            if (product) {
              const stockMap = getNormalizedStock(product.stock);
              stockMap[branchName] = Math.max(0, (stockMap[branchName] || 0) - qty);
              await Product(dbName).findOneAndUpdate(
                { id: prodId },
                { $set: { stock: stockMap } }
              );
            }
          }
          await Transaction(dbName).deleteOne({ id: refId });
          rollbackSuccess = true;
          rollbackDetails = `Reversed Stock In of ${qty} units for Product ${prodId} at ${branchName}`;
        } else if (action === "Stock Out") {
          // Reverting Stock Out -> Increase stock by qty
          if (prodId && qty > 0) {
            const product = await Product(dbName).findOne({ id: prodId });
            if (product) {
              const stockMap = getNormalizedStock(product.stock);
              stockMap[branchName] = (stockMap[branchName] || 0) + qty;
              await Product(dbName).findOneAndUpdate(
                { id: prodId },
                { $set: { stock: stockMap } }
              );
            }
          }
          await Transaction(dbName).deleteOne({ id: refId });
          rollbackSuccess = true;
          rollbackDetails = `Reversed Stock Out of ${qty} units for Product ${prodId} at ${branchName}`;
        } else if (action === "Stock Adjust") {
          if (log.previousState?.stock && prodId) {
            await Product(dbName).findOneAndUpdate(
              { id: prodId },
              { $set: { stock: log.previousState.stock } }
            );
          }
          await Transaction(dbName).deleteOne({ id: refId });
          rollbackSuccess = true;
          rollbackDetails = `Restored previous stock levels for Product ${prodId}`;
        }
      }
      // 2. Stock Transfer
      else if (action === "Stock Transfer" || entityType === "Transfer") {
        const transfer =
          (await Transfer(dbName).findOne({ id: refId }).lean()) ||
          log.newState?.transfer ||
          log.newState;
        const prodId = transfer?.productId || log.previousState?.productId;
        const qty = Number(transfer?.quantity || log.previousState?.quantity || 0);
        const fromB = transfer?.fromBranch || log.previousState?.fromBranch;
        const toB = transfer?.toBranch || log.previousState?.toBranch;

        if (prodId && qty > 0 && fromB && toB) {
          const product = await Product(dbName).findOne({ id: prodId });
          if (product) {
            const stockMap = getNormalizedStock(product.stock);
            stockMap[fromB] = (stockMap[fromB] || 0) + qty;
            stockMap[toB] = Math.max(0, (stockMap[toB] || 0) - qty);
            await Product(dbName).findOneAndUpdate(
              { id: prodId },
              { $set: { stock: stockMap } }
            );
          }
          if (log.newState?.txIds && Array.isArray(log.newState.txIds)) {
            await Transaction(dbName).deleteMany({ id: { $in: log.newState.txIds } });
          } else if (refId) {
            const ids = refId.split(",").map((s) => s.trim());
            await Transaction(dbName).deleteMany({ id: { $in: ids } });
          }
          rollbackSuccess = true;
          rollbackDetails = `Reversed Stock Transfer of ${qty} units from ${toB} back to ${fromB}`;
        }
      }
      // 3. Products
      else if (action.includes("Product") || entityType === "Product") {
        if (action === "Product Created") {
          await Product(dbName).deleteOne({ id: refId });
          rollbackSuccess = true;
          rollbackDetails = `Deleted accidentally created Product ${refId}`;
        } else if (action === "Product Updated") {
          if (log.previousState) {
            const { _id, id: pid, ...rest } = log.previousState;
            await Product(dbName).findOneAndUpdate({ id: refId }, rest, { new: true });
            rollbackSuccess = true;
            rollbackDetails = `Restored Product ${refId} to previous values`;
          }
        } else if (action === "Product Deleted") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Product(dbName).create(rest);
            rollbackSuccess = true;
            rollbackDetails = `Re-instated deleted Product ${refId}`;
          }
        }
      }
      // 4. Categories
      else if (action.includes("Category") || entityType === "Category") {
        if (action === "Category Created") {
          await Category(dbName).deleteOne({ $or: [{ name: refId }, { id: refId }] });
          rollbackSuccess = true;
          rollbackDetails = `Deleted created Category ${refId}`;
        } else if (action === "Category Updated") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Category(dbName).findOneAndUpdate(
              { $or: [{ name: refId }, { id: refId }] },
              rest
            );
            rollbackSuccess = true;
            rollbackDetails = `Restored Category ${refId} to previous values`;
          }
        } else if (action === "Category Deleted") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Category(dbName).create(rest);
            rollbackSuccess = true;
            rollbackDetails = `Re-instated deleted Category ${refId}`;
          }
        }
      }
      // 5. Suppliers
      else if (action.includes("Supplier") || entityType === "Supplier") {
        if (action === "Supplier Created") {
          await Supplier(dbName).deleteOne({ name: refId });
          rollbackSuccess = true;
          rollbackDetails = `Deleted created Supplier ${refId}`;
        } else if (action === "Supplier Updated") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Supplier(dbName).findOneAndUpdate({ name: refId }, rest);
            rollbackSuccess = true;
            rollbackDetails = `Restored Supplier ${refId} to previous values`;
          }
        } else if (action === "Supplier Deleted") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Supplier(dbName).create(rest);
            rollbackSuccess = true;
            rollbackDetails = `Re-instated deleted Supplier ${refId}`;
          }
        }
      }
      // 6. Orders
      else if (action.includes("Order") || entityType === "Order") {
        if (action === "Order Created") {
          await Order(dbName).deleteOne({ id: refId });
          rollbackSuccess = true;
          rollbackDetails = `Deleted created Order ${refId}`;
        } else if (action === "Order Updated") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Order(dbName).findOneAndUpdate({ id: refId }, rest);
            rollbackSuccess = true;
            rollbackDetails = `Restored Order ${refId} to previous status`;
          }
        } else if (action === "Order Deleted") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Order(dbName).create(rest);
            rollbackSuccess = true;
            rollbackDetails = `Re-instated deleted Order ${refId}`;
          }
        }
      }
      // 7. Invoices
      else if (action.includes("Invoice") || entityType === "Invoice" || log.category === "Invoice") {
        if (action === "Invoice Uploaded" || action === "Invoice Created") {
          await Invoice().deleteOne({
            $or: [{ invoiceNumber: refId }, { id: refId }, { invoiceNumber: log.target }],
          });
          rollbackSuccess = true;
          rollbackDetails = `Deleted uploaded Invoice #${log.target || refId}`;
        } else if (action === "Invoice Deleted") {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Invoice().create(rest);
            rollbackSuccess = true;
            rollbackDetails = `Re-instated deleted Invoice #${log.target || refId}`;
          }
        } else if (
          action === "Invoice Updated" ||
          action === "Invoice Verified" ||
          action === "Invoice Approved" ||
          action === "Invoice Paid" ||
          action === "Invoice Rejected" ||
          action === "Physical Verification" ||
          action === "Bank Details Added"
        ) {
          if (log.previousState) {
            const { _id, ...rest } = log.previousState;
            await Invoice().findOneAndUpdate(
              { $or: [{ invoiceNumber: refId }, { id: refId }, { invoiceNumber: log.target }] },
              rest
            );
            rollbackSuccess = true;
            rollbackDetails = `Restored Invoice #${log.target || refId} to previous status`;
          }
        }
      }

      if (!rollbackSuccess) {
        return reply.status(400).send({
          success: false,
          message: `Automatic rollback not available for '${action}' (target entity not found or insufficient snapshot).`,
        });
      }

      // Mark log as reverted
      await auditModel.updateOne(
        { id },
        {
          $set: {
            isReverted: true,
            revertedAt: new Date(),
            revertedBy: currentUser.userName,
            revertReason: reason || "Manual rollback via folder audit log",
          },
        }
      );

      // Record a new Audit Log for the Revert action itself
      await createAuditLog(
        dbName,
        {
          action: "Action Reverted",
          category: log.category || "System",
          details: `Reverted ${log.id} (${log.action}) - ${rollbackDetails}${
            reason ? ` [Reason: ${reason}]` : ""
          }`,
          target: log.target || log.referenceId,
          branch: log.branch || "Global",
          referenceId: log.id,
        },
        request
      );

      return {
        success: true,
        message: `Successfully rolled back action ${log.id}`,
        details: rollbackDetails,
      };
    } catch (error) {
      console.error("Revert error:", error);
      return reply.status(500).send({ success: false, message: error.message });
    }
  });

  // ── PRODUCTS ──
  fastify.get("/products", async (request, reply) => {
    const dbName = getDbName(request);
    const { branch } = request.query;

    // Auto-heal duplicate product IDs across all products in the database
    const allProds = await Product(dbName).find().sort({ createdAt: 1 });
    const seenIds = new Set();
    let maxNum = 0;
    for (const p of allProds) {
      if (p.id && p.id.startsWith("PROD-")) {
        const num = parseInt(p.id.replace("PROD-", ""), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    }
    for (const p of allProds) {
      if (!p.id || seenIds.has(p.id)) {
        maxNum++;
        const newId = `PROD-${String(maxNum).padStart(3, "0")}`;
        await Product(dbName).updateOne(
          { _id: p._id },
          { $set: { id: newId } },
        );
        p.id = newId;
      }
      seenIds.add(p.id);
    }

    let query = {};
    if (branch && branch !== "All") {
      query = {
        $or: [{ branch: branch }, { [`stock.${branch}`]: { $gt: 0 } }],
      };
    }

    const list = await Product(dbName).find(query).sort({ createdAt: -1 });
    return { success: true, data: list };
  });

  fastify.post("/products", async (request, reply) => {
    const dbName = getDbName(request);

    // Find highest existing numerical PROD-XXX ID across all products
    const allProducts = await Product(dbName).find({}, { id: 1 });
    let maxNum = 0;
    for (const p of allProducts) {
      if (p.id && p.id.startsWith("PROD-")) {
        const num = parseInt(p.id.replace("PROD-", ""), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    }
    const nextId = `PROD-${String(maxNum + 1).padStart(3, "0")}`;

    try {
      const created = await Product(dbName).create({
        ...request.body,
        id: nextId,
      });

      await createAuditLog(
        dbName,
        {
          action: "Product Created",
          category: "Products",
          details: `Registered product ${created.name} (SKU: ${created.id}) under category ${created.category || "General"}`,
          target: created.name,
          branch: "Global",
          referenceId: created.id,
        },
        request,
      );

      // Log initial stock transactions if product was created with branch stocks
      const branches = ["Ahmedabad", "Ludhiana", "Delhi", "Mumbai"];
      for (const branch of branches) {
        if (created.stock && created.stock[branch] > 0) {
          const nextTxId = await getNextTxId(dbName);
          const dateStr = new Date()
            .toISOString()
            .replace("T", " ")
            .substring(0, 16);
          const tx = await Transaction(dbName).create({
            id: nextTxId,
            date: dateStr,
            productId: created.id,
            productName: created.name,
            type: "Stock In",
            quantity: created.stock[branch],
            reasonOrLocation: "Initial Stock Seeding",
            notes: "Recorded automatically on product creation.",
            branch: branch,
          });

          await createAuditLog(
            dbName,
            {
              action: "Stock In",
              category: "Stock",
              details: `Initial stock seeding of ${created.stock[branch]} units for product ${created.name} in branch ${branch}`,
              target: created.name,
              branch: branch,
              referenceId: tx.id,
            },
            request,
          );
        }
      }

      return { success: true, data: created };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/products/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const updateData = { ...request.body };
      // Prevent overwriting original creation timestamp during product edit
      if (updateData.createdAt) {
        delete updateData.createdAt;
      }
      if (updateData.stock) {
        const existingProd = await Product(dbName).findOne({ id }).lean();
        const existingStock =
          typeof existingProd?.stock === "object" && existingProd?.stock !== null
            ? existingProd.stock
            : {
                Ahmedabad: 0,
                Ludhiana: 0,
                Delhi: typeof existingProd?.stock === "number" ? existingProd.stock : 0,
                Mumbai: 0,
              };

        if (typeof updateData.stock === "object" && updateData.stock !== null) {
          updateData.stock = {
            Ahmedabad:
              typeof updateData.stock.Ahmedabad === "number"
                ? updateData.stock.Ahmedabad
                : existingStock.Ahmedabad || 0,
            Ludhiana:
              typeof updateData.stock.Ludhiana === "number"
                ? updateData.stock.Ludhiana
                : existingStock.Ludhiana || 0,
            Delhi:
              typeof updateData.stock.Delhi === "number"
                ? updateData.stock.Delhi
                : existingStock.Delhi || 0,
            Mumbai:
              typeof updateData.stock.Mumbai === "number"
                ? updateData.stock.Mumbai
                : existingStock.Mumbai || 0,
          };
        }
      }

      const updated = await Product(dbName).findOneAndUpdate(
        { id },
        updateData,
        { new: true },
      );
      if (!updated)
        return reply
          .status(404)
          .send({ success: false, message: "Product not found" });

      await createAuditLog(
        dbName,
        {
          action: "Product Updated",
          category: "Products",
          details: `Updated product details for ${updated.name} (SKU: ${id})`,
          target: updated.name,
          branch: "Global",
          referenceId: id,
        },
        request,
      );

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/products/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    const existing = await Product(dbName).findOne({ id }).lean();
    await Product(dbName).findOneAndDelete({ id });

    await createAuditLog(
      dbName,
      {
        action: "Product Deleted",
        category: "Products",
        details: `Deleted product ${existing?.name || id} (SKU: ${id})`,
        target: existing?.name || id,
        branch: "Global",
        referenceId: id,
      },
      request,
    );

    return { success: true };
  });

  // ── CATEGORIES ──
  fastify.get("/categories", async (request, reply) => {
    const dbName = getDbName(request);
    const list = await Category(dbName).find();
    return { success: true, data: list };
  });

  fastify.post("/categories", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const created = await Category(dbName).create(request.body);

      await createAuditLog(
        dbName,
        {
          action: "Category Created",
          category: "Categories",
          details: `Added new category: ${created.name}`,
          target: created.name,
          branch: "Global",
        },
        request,
      );

      return { success: true, data: created };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/categories/:name", async (request, reply) => {
    const dbName = getDbName(request);
    const { name } = request.params;
    await Category(dbName).findOneAndDelete({ name });

    await createAuditLog(
      dbName,
      {
        action: "Category Deleted",
        category: "Categories",
        details: `Deleted category: ${name}`,
        target: name,
        branch: "Global",
      },
      request,
    );

    return { success: true };
  });

  fastify.put("/categories/:name", async (request, reply) => {
    const dbName = getDbName(request);
    const { name } = request.params;
    try {
      const updated = await Category(dbName).findOneAndUpdate(
        { name },
        request.body,
        { new: true },
      );
      if (!updated)
        return reply
          .status(404)
          .send({ success: false, message: "Category not found" });

      await createAuditLog(
        dbName,
        {
          action: "Category Updated",
          category: "Categories",
          details: `Updated category from ${name} to ${updated.name}`,
          target: updated.name,
          branch: "Global",
        },
        request,
      );

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // ── SUPPLIERS ──
  fastify.get("/suppliers", async (request, reply) => {
    const dbName = getDbName(request);
    const list = await Supplier(dbName).find();
    return { success: true, data: list };
  });

  fastify.post("/suppliers", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const created = await Supplier(dbName).create(request.body);

      await createAuditLog(
        dbName,
        {
          action: "Supplier Created",
          category: "Suppliers",
          details: `Added new supplier: ${created.name}${created.contact ? ` (Contact: ${created.contact})` : ""}`,
          target: created.name,
          branch: "Global",
        },
        request,
      );

      return { success: true, data: created };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/suppliers/:name", async (request, reply) => {
    const dbName = getDbName(request);
    const { name } = request.params;
    try {
      const updated = await Supplier(dbName).findOneAndUpdate(
        { name },
        request.body,
        { new: true },
      );
      if (!updated)
        return reply
          .status(404)
          .send({ success: false, message: "Supplier not found" });

      await createAuditLog(
        dbName,
        {
          action: "Supplier Updated",
          category: "Suppliers",
          details: `Updated supplier details for ${updated.name}`,
          target: updated.name,
          branch: "Global",
        },
        request,
      );

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/suppliers/:name", async (request, reply) => {
    const dbName = getDbName(request);
    const { name } = request.params;
    await Supplier(dbName).findOneAndDelete({ name });

    await createAuditLog(
      dbName,
      {
        action: "Supplier Deleted",
        category: "Suppliers",
        details: `Deleted supplier: ${name}`,
        target: name,
        branch: "Global",
      },
      request,
    );

    return { success: true };
  });

  // ── REPORTS ──
  fastify.get("/reports", async (request, reply) => {
    const dbName = getDbName(request);
    const { branch, productId, type, startDate, endDate } = request.query;

    const filter = {};
    if (branch && branch !== "All") {
      filter.branch = branch;
    }
    if (productId) {
      filter.productId = { $regex: productId, $options: "i" };
    }
    if (type && type !== "All") {
      filter.type = type;
    }

    const txList = await Transaction(dbName)
      .find(filter)
      .sort({ date: -1, createdAt: -1 });

    let filtered = txList;
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;
      filtered = txList.filter((tx) => {
        const txDate = new Date(tx.date || tx.createdAt);
        if (start && txDate < start) return false;
        if (end && txDate > end) return false;
        return true;
      });
    }

    filtered.sort((a, b) => new Date(b.date || b.createdAt).getTime() - new Date(a.date || a.createdAt).getTime());

    return { success: true, data: filtered };
  });

  fastify.get("/reports/monthly-stock", async (request, reply) => {
    const dbName = getDbName(request);
    const { year, month, branch, search } = request.query;

    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1; // 1-12

    // Month boundary dates
    const monthStart = new Date(targetYear, targetMonth - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    // Fetch products
    const prodFilter = {};
    if (search) {
      prodFilter.$or = [
        { name: { $regex: search, $options: "i" } },
        { id: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
      ];
    }
    const products = await Product(dbName).find(prodFilter).lean();

    // Fetch transactions
    const txFilter = {};
    if (branch && branch !== "All") {
      txFilter.branch = branch;
    }
    const allTransactions = await Transaction(dbName).find(txFilter).lean();

    const branchesList = ["Ahmedabad", "Ludhiana", "Delhi", "Mumbai"];

    const reportData = [];

    for (const prod of products) {
      const prodTxs = allTransactions.filter(
        (t) =>
          t.productId === prod.id ||
          t.productId === String(prod._id) ||
          (prod._id && String(t.productId) === String(prod._id)),
      );
      const relevantBranches =
        branch && branch !== "All" ? [branch] : branchesList;

      const txTimestamps = prodTxs
        .map((t) => new Date(t.date || t.createdAt).getTime())
        .filter((t) => !isNaN(t));

      let prodCreatedAt = prod.createdAt ? new Date(prod.createdAt) : null;
      if (txTimestamps.length > 0) {
        const earliestTx = new Date(Math.min(...txTimestamps));
        if (!prodCreatedAt || earliestTx < prodCreatedAt) {
          prodCreatedAt = earliestTx;
        }
      }
      if (!prodCreatedAt) {
        prodCreatedAt = new Date();
      }

      for (const b of relevantBranches) {
        const branchTxs = prodTxs.filter((t) => t.branch === b);

        // Fetch/derive the supplier name and the Amount/Price entered on Stock In
        const supplierName = extractSupplierName(branchTxs, prod);
        const purchaseAmount = extractPurchaseAmount(branchTxs);
        const purchaseRate = getSupplierRate(prod, supplierName);
        const lastPurchaseDate = getLastPurchaseDate(branchTxs);

        if (prodCreatedAt > monthEnd) {
          reportData.push({
            productId: prod.id,
            productName: prod.name,
            category: prod.category,
            supplier: supplierName,
            sku: prod.sku || "",
            branch: b,
            openingStock: 0,
            purchaseRate,
            purchaseValue: purchaseAmount !== null ? purchaseAmount : 0,
            stockIn: 0,
            stockOut: 0,
            closingStock: 0,
            lastPurchaseDate: lastPurchaseDate,
          });
          continue;
        }

        const liveStock =
          typeof prod.stock === "object" && prod.stock !== null
            ? prod.stock[b] || 0
            : typeof prod.stock === "number"
              ? prod.stock
              : 0;

        let netTxAfterMonthEnd = 0;
        let stockIn = 0;
        let stockOut = 0;

        for (const tx of branchTxs) {
          const txDate = new Date(tx.date || tx.createdAt);
          if (txDate > monthEnd) {
            if (tx.type === "Stock In") netTxAfterMonthEnd += tx.quantity;
            else if (tx.type === "Stock Out") netTxAfterMonthEnd -= tx.quantity;
          } else if (txDate >= monthStart && txDate <= monthEnd) {
            if (tx.type === "Stock In") stockIn += tx.quantity;
            else if (tx.type === "Stock Out") stockOut += tx.quantity;
          }
        }

        const closingStock = Math.max(0, liveStock - netTxAfterMonthEnd);
        let openingStock = 0;
        if (prodCreatedAt > monthStart) {
          openingStock = 0;
        } else {
          openingStock = Math.max(0, closingStock - stockIn + stockOut);
        }

        reportData.push({
          productId: prod.id,
          productName: prod.name,
          category: prod.category,
          supplier: supplierName,
          sku: prod.sku || "",
          branch: b,
          openingStock: Math.max(0, openingStock),
          purchaseRate,
          purchaseValue:
            purchaseAmount !== null
              ? purchaseAmount
              : Math.max(0, openingStock) * purchaseRate,
          stockIn,
          stockOut,
          closingStock: Math.max(0, closingStock),
          lastPurchaseDate: lastPurchaseDate,
        });
      }
    }

    reportData.sort((a, b) => {
      const timeA = a.lastPurchaseDate && a.lastPurchaseDate !== "-" ? new Date(a.lastPurchaseDate).getTime() : 0;
      const timeB = b.lastPurchaseDate && b.lastPurchaseDate !== "-" ? new Date(b.lastPurchaseDate).getTime() : 0;
      const validA = !isNaN(timeA) && timeA > 0;
      const validB = !isNaN(timeB) && timeB > 0;
      if (validA && validB) return timeB - timeA;
      if (validA && !validB) return -1;
      if (!validA && validB) return 1;
      return (a.productName || "").localeCompare(b.productName || "");
    });

    return {
      success: true,
      data: reportData,
      meta: {
        year: targetYear,
        month: targetMonth,
        branch: branch || "All",
      },
    };
  });

  // ── TRANSACTIONS ──
  const autoHealTransactionIds = async (dbName) => {
    const allTxs = await Transaction(dbName).find().sort({ createdAt: 1 });
    const seenIds = new Set();
    let maxNum = 100;
    for (const t of allTxs) {
      if (t.id && t.id.startsWith("TX-")) {
        const num = parseInt(t.id.replace("TX-", ""), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    }
    for (const t of allTxs) {
      if (!t.id || seenIds.has(t.id)) {
        maxNum++;
        const newId = `TX-${maxNum}`;
        await Transaction(dbName).updateOne(
          { _id: t._id },
          { $set: { id: newId } },
        );
        t.id = newId;
      }
      seenIds.add(t.id);
    }
  };

  const getNormalizedStock = (rawStock) => {
    const isObj = typeof rawStock === "object" && rawStock !== null && !Array.isArray(rawStock);
    return {
      Ahmedabad: isObj && !isNaN(Number(rawStock.Ahmedabad)) ? Number(rawStock.Ahmedabad) : 0,
      Ludhiana: isObj && !isNaN(Number(rawStock.Ludhiana)) ? Number(rawStock.Ludhiana) : 0,
      Delhi: isObj && !isNaN(Number(rawStock.Delhi)) ? Number(rawStock.Delhi) : (typeof rawStock === "number" && !isNaN(rawStock) ? rawStock : 0),
      Mumbai: isObj && !isNaN(Number(rawStock.Mumbai)) ? Number(rawStock.Mumbai) : 0,
    };
  };

  const getNextTxId = async (dbName) => {
    const allTxs = await Transaction(dbName).find({}, { id: 1 });
    let maxNum = 100;
    for (const t of allTxs) {
      if (t.id && t.id.startsWith("TX-")) {
        const num = parseInt(t.id.replace("TX-", ""), 10);
        if (!isNaN(num) && num > maxNum) maxNum = num;
      }
    }
    return `TX-${maxNum + 1}`;
  };

  fastify.get("/transactions", async (request, reply) => {
    const dbName = getDbName(request);
    await autoHealTransactionIds(dbName);
    const { branch } = request.query;
    const filter = branch && branch !== "All" ? { branch } : {};
    const list = await Transaction(dbName).find(filter).sort({ date: -1, createdAt: -1 });
    return { success: true, data: list };
  });

  fastify.post("/transactions", async (request, reply) => {
    const dbName = getDbName(request);
    const {
      productId,
      type,
      quantity,
      reasonOrLocation,
      notes,
      branch,
      purchaseDate,
      amount,
      supplier,
      invoiceNumber,
      model,
      serialNumber,
    } = request.body;

    const branchToUse = branch || "Ahmedabad";

    const numQuantity = parseInt(quantity, 10);
    if (isNaN(numQuantity) || numQuantity <= 0) {
      return reply
        .status(400)
        .send({ success: false, message: "A valid positive quantity is required" });
    }

    try {
      const prodModel = Product(dbName);
      const product = await prodModel.findOne({ id: productId });
      if (!product) {
        return reply
          .status(404)
          .send({ success: false, message: "Product not found" });
      }

      const stockMap = getNormalizedStock(product.stock);
      const currentStock = stockMap[branchToUse] || 0;

      if (type === "Stock Out" && currentStock < numQuantity) {
        return reply.status(400).send({
          success: false,
          message: "Insufficient stock in this branch",
        });
      }

      const newStock =
        type === "Stock In" ? currentStock + numQuantity : Math.max(0, currentStock - numQuantity);

      stockMap[branchToUse] = newStock;

      // Update the entire stock object directly
      await prodModel.findOneAndUpdate(
        { id: productId },
        { $set: { stock: stockMap } },
      );

      const nextTxId = await getNextTxId(dbName);
      const dateStr = new Date()
        .toISOString()
        .replace("T", " ")
        .substring(0, 16);

      // Build transaction object with all fields
      const transactionData = {
        id: nextTxId,
        date: dateStr,
        productId,
        productName: product.name,
        type,
        quantity: numQuantity,
        reasonOrLocation: reasonOrLocation || "",
        notes: notes || "",
        branch: branchToUse,
      };

      // Only add optional fields if they exist and are valid
      if (purchaseDate) transactionData.purchaseDate = purchaseDate;
      if (amount !== undefined && amount !== null && !isNaN(Number(amount)))
        transactionData.amount = Number(amount);
      if (supplier) transactionData.supplier = supplier;
      if (invoiceNumber) transactionData.invoiceNumber = invoiceNumber;
      if (model) transactionData.model = model;
      if (serialNumber) transactionData.serialNumber = serialNumber;

      const transaction = await Transaction(dbName).create(transactionData);

      await createAuditLog(
        dbName,
        {
          action: type,
          category: "Stock",
          details: `${type} of ${numQuantity} units for product ${product.name} [Branch: ${branchToUse}]${notes ? ` (Notes: ${notes})` : ""}${supplier ? ` [Supplier: ${supplier}]` : ""}${invoiceNumber ? ` [Invoice: ${invoiceNumber}]` : ""}${reasonOrLocation ? ` [Reason/Loc: ${reasonOrLocation}]` : ""}`,
          target: product.name,
          branch: branchToUse,
          referenceId: transaction.id,
        },
        request,
      );

      return { success: true, data: transaction };
    } catch (error) {
      console.error("Error creating transaction:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.post("/transactions/transfer", async (request, reply) => {
    const dbName = getDbName(request);
    const { productId, quantity, fromBranch, toBranch, notes } = request.body;

    if (!fromBranch || !toBranch || fromBranch === toBranch) {
      return reply
        .status(400)
        .send({ success: false, message: "Invalid branches for transfer" });
    }

    const numQuantity = parseInt(quantity, 10);
    if (isNaN(numQuantity) || numQuantity <= 0) {
      return reply
        .status(400)
        .send({ success: false, message: "Valid transfer quantity is required" });
    }

    try {
      const prodModel = Product(dbName);
      const product = await prodModel.findOne({ id: productId });
      if (!product)
        return reply
          .status(404)
          .send({ success: false, message: "Product not found" });

      const stockMap = getNormalizedStock(product.stock);
      const currentFromStock = stockMap[fromBranch] || 0;
      if (currentFromStock < numQuantity) {
        return reply.status(400).send({
          success: false,
          message: `Insufficient stock in ${fromBranch}`,
        });
      }

      stockMap[fromBranch] = Math.max(0, currentFromStock - numQuantity);
      stockMap[toBranch] = (stockMap[toBranch] || 0) + numQuantity;

      // Update stocks cleanly
      await prodModel.findOneAndUpdate(
        { id: productId },
        { $set: { stock: stockMap } },
      );

      const txId1 = await getNextTxId(dbName);
      const dateStr = new Date()
        .toISOString()
        .replace("T", " ")
        .substring(0, 16);

      // Record Stock Out in source branch
      await Transaction(dbName).create({
        id: txId1,
        date: dateStr,
        productId,
        productName: product.name,
        type: "Stock Out",
        quantity: numQuantity,
        reasonOrLocation: `Transfer to ${toBranch}`,
        notes,
        branch: fromBranch,
      });

      const txId2 = await getNextTxId(dbName);

      // Record Stock In in destination branch
      await Transaction(dbName).create({
        id: txId2,
        date: dateStr,
        productId,
        productName: product.name,
        type: "Stock In",
        quantity: numQuantity,
        reasonOrLocation: `Transfer from ${fromBranch}`,
        notes,
        branch: toBranch,
      });

      await createAuditLog(
        dbName,
        {
          action: "Stock Transfer",
          category: "Stock",
          details: `Transferred ${numQuantity} units of ${product.name} from ${fromBranch} to ${toBranch}${notes ? ` (Notes: ${notes})` : ""}`,
          target: product.name,
          branch: `${fromBranch} -> ${toBranch}`,
          referenceId: `${txId1}, ${txId2}`,
        },
        request,
      );

      return { success: true };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // ── ORDERS ──
  fastify.get("/orders", async (request, reply) => {
    const dbName = getDbName(request);
    const { branch } = request.query;
    const filter = branch && branch !== "All" ? { branch } : {};
    const list = await Order(dbName).find(filter).sort({ createdAt: -1 });
    return { success: true, data: list };
  });

  fastify.post("/orders", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const orderModel = Order(dbName);

      const branchName = (request.body.branch || "Delhi").trim();
      const bLower = branchName.toLowerCase();
      let bCode = "DEL";
      if (bLower.includes("delhi")) bCode = "DEL";
      else if (bLower.includes("ahmedabad")) bCode = "AMD";
      else if (bLower.includes("ludhiana")) bCode = "LDH";
      else if (bLower.includes("mumbai")) bCode = "MUM";
      else bCode = branchName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 3) || "DEL";

      const prefix = `${bCode}-PO`;
      const branchOrders = await orderModel.find({
        $or: [
          { id: new RegExp(`^${bCode}-`) },
          { branch: branchName }
        ]
      });
      const nums = branchOrders
        .filter(o => o.id && !o.id.toUpperCase().startsWith("ORD-"))
        .map(o => {
          const m = (o.id || "").match(/\d+/g);
          return m ? parseInt(m[m.length - 1], 10) : 0;
        })
        .filter(n => !isNaN(n) && n > 0);
      const nextSeq = nums.length > 0 ? Math.max(...nums) + 1 : (branchOrders.length + 1);
      const branchGenId = `${prefix}-${String(nextSeq).padStart(3, "0")}`;

      let nextId = request.body.id || request.body.orderId;
      if (!nextId || nextId.toUpperCase().startsWith("ORD-")) {
        nextId = branchGenId;
      }

      const created = await orderModel.create({
        ...request.body,
        id: nextId,
      });

      await createAuditLog(
        dbName,
        {
          action: "Order Created",
          category: "Orders",
          details: `Created order ${created.id} for supplier ${created.supplier || "N/A"} (${(created.items || []).length} items, Total: ₹${created.totalAmount || 0}) [Branch: ${created.branch || "Global"}]`,
          target: created.supplier || created.id,
          branch: created.branch || "Global",
          referenceId: created.id,
        },
        request,
      );

      return { success: true, data: created };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/orders/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const updated = await Order(dbName).findOneAndUpdate(
        { id },
        request.body,
        { new: true },
      );
      if (!updated)
        return reply
          .status(404)
          .send({ success: false, message: "Order not found" });

      await createAuditLog(
        dbName,
        {
          action: "Order Updated",
          category: "Orders",
          details: `Updated order ${id} (Status: ${updated.status}, Branch: ${updated.branch || "Global"})`,
          target: updated.supplier || id,
          branch: updated.branch || "Global",
          referenceId: id,
        },
        request,
      );

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/orders/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    await Order(dbName).findOneAndDelete({ id });

    await createAuditLog(
      dbName,
      {
        action: "Order Deleted",
        category: "Orders",
        details: `Deleted order ${id}`,
        target: id,
        branch: "Global",
        referenceId: id,
      },
      request,
    );

    return { success: true };
  });

  // ── ASSET ASSIGNMENTS ──
  fastify.get("/assets", async (request, reply) => {
    const dbName = getDbName(request);
    const { branch, department } = request.query;
    const filter = {};
    if (branch && branch !== "All") filter.branch = branch;
    if (department && department !== "All") filter.department = department;
    const list = await AssetAssignment(dbName)
      .find(filter)
      .sort({ assignedDate: -1, createdAt: -1 });
    return { success: true, data: list };
  });

  fastify.post("/assets", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const assetModel = AssetAssignment(dbName);
      const productModel = Product(dbName);
      const txModel = Transaction(dbName);
      const serialModel = AssetSerial(dbName);

      const allAssets = await assetModel.find({}, { id: 1 }).lean();
      let maxNum = 0;
      for (const a of allAssets) {
        if (a.id && a.id.startsWith("AST-")) {
          const num = parseInt(a.id.replace("AST-", ""), 10);
          if (!isNaN(num) && num > maxNum) maxNum = num;
        }
      }
      const nextId = `AST-${String(maxNum + 1).padStart(3, "0")}`;

      const branchToUse = request.body.branch || "Ahmedabad";
      const qty = Number(request.body.quantity) || 1;

      const created = await assetModel.create({
        ...request.body,
        id: nextId,
        branch: branchToUse,
        quantity: qty,
        assignedDate: new Date().toISOString(),
        status: "Assigned",
      });

      // Deduct from stock
      const product = await productModel.findOne({ id: created.productId });
      if (product) {
        const stockMap = getNormalizedStock(product.stock);
        const currentStock = stockMap[branchToUse] || 0;
        const newStock = Math.max(0, currentStock - qty);
        stockMap[branchToUse] = newStock;

        await productModel.findOneAndUpdate(
          { id: product.id },
          { $set: { stock: stockMap } },
        );

        // Log Stock Out Transaction
        const nextTxId = await getNextTxId(dbName);
        const tx = await txModel.create({
          id: nextTxId,
          date: new Date().toISOString().replace("T", " ").substring(0, 16),
          productId: product.id,
          productName: product.name,
          type: "Stock Out",
          quantity: qty,
          branch: branchToUse,
          reasonOrLocation: "Asset Assignment",
          notes: `Assigned to: ${created.assignedTo}`,
          model: created.modelNumber || undefined,
          serialNumber: created.serialNumber || undefined,
        });

        await createAuditLog(
          dbName,
          {
            action: "Stock Out",
            category: "Stock",
            details: `Stock Out of ${qty} units for product ${product.name} due to Asset Assignment to ${created.assignedTo} in branch ${branchToUse}`,
            target: product.name,
            branch: branchToUse,
            referenceId: tx.id,
          },
          request,
        );
      }

      // Update or create matching AssetSerial unit
      const cleanSn = (created.serialNumber || "").trim();
      const snToMatch = cleanSn || created.id;

      const existingSerial = await serialModel.findOne({
        $or: [
          { serialNumber: cleanSn },
          { serialNumber: { $regex: new RegExp(`^${snToMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") } }
        ]
      });

      if (existingSerial) {
        await serialModel.updateOne(
          { _id: existingSerial._id },
          {
            $set: {
              status: "Assigned",
              assignedTo: created.assignedTo,
              assignedDate: new Date().toISOString().slice(0, 10),
              branch: branchToUse,
              model: created.modelNumber || existingSerial.model || "",
            },
          },
        );
      } else {
        // Auto-create AssetSerial so it immediately appears in All Assets as Assigned!
        const allSerials = await serialModel.find({}, { id: 1 }).lean();
        let maxNum = 0;
        for (const s of allSerials) {
          if (s.id && s.id.startsWith("AS-")) {
            const num = parseInt(s.id.replace("AS-", ""), 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
        }
        const nextSerialId = `AS-${String(maxNum + 1).padStart(4, "0")}`;
        await serialModel.create({
          id: nextSerialId,
          productId: created.productId || "PROD-ASSET",
          productName: created.productName || "Asset Device",
          serialNumber: snToMatch,
          model: created.modelNumber || "",
          warranty: created.warranty || "",
          purchaseDate: new Date().toISOString().slice(0, 10),
          invoiceNumber: "",
          supplier: "",
          branch: branchToUse,
          amount: 0,
          status: "Assigned",
          assignedTo: created.assignedTo,
          assignedDate: new Date().toISOString().slice(0, 10),
          notes: created.notes || "",
        });
      }

      await createAuditLog(
        dbName,
        {
          action: "Asset Assigned",
          category: "Assets",
          details: `Assigned asset ${created.productName || created.productId} (${qty} units) to ${created.assignedTo} in branch ${branchToUse}${created.serialNumber ? ` [Serial: ${created.serialNumber}]` : ""}`,
          target: created.productName || created.assignedTo,
          branch: branchToUse,
          referenceId: created.id,
        },
        request,
      );

      return { success: true, data: created };
    } catch (error) {
      console.error("Error in POST /assets:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/assets/:id/return", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const assetModel = AssetAssignment(dbName);
      const productModel = Product(dbName);
      const txModel = Transaction(dbName);
      const serialModel = AssetSerial(dbName);

      const assignment = await assetModel.findOne({ id });
      if (!assignment || assignment.status === "Returned") {
        return reply
          .status(400)
          .send({ success: false, message: "Invalid or already returned assignment" });
      }

      assignment.status = "Returned";
      assignment.returnedDate = new Date().toISOString();
      await assignment.save();

      const branchToUse = assignment.branch || "Ahmedabad";
      const qty = Number(assignment.quantity) || 1;

      // Return to stock
      const product = await productModel.findOne({ id: assignment.productId });
      if (product) {
        const stockMap = getNormalizedStock(product.stock);
        const currentStock = stockMap[branchToUse] || 0;
        const newStock = currentStock + qty;
        stockMap[branchToUse] = newStock;

        await productModel.findOneAndUpdate(
          { id: product.id },
          { $set: { stock: stockMap } },
        );

        // Log Stock In Transaction with branch
        const nextTxId = await getNextTxId(dbName);
        const tx = await txModel.create({
          id: nextTxId,
          date: new Date().toISOString().replace("T", " ").substring(0, 16),
          productId: product.id,
          productName: product.name,
          type: "Stock In",
          quantity: qty,
          branch: branchToUse,
          reasonOrLocation: "Asset Returned",
          notes: `Returned by: ${assignment.assignedTo}`,
          model: assignment.modelNumber || undefined,
          serialNumber: assignment.serialNumber || undefined,
        });

        await createAuditLog(
          dbName,
          {
            action: "Stock In",
            category: "Stock",
            details: `Stock In of ${qty} units for product ${product.name} due to Asset Return from ${assignment.assignedTo} in branch ${branchToUse}`,
            target: product.name,
            branch: branchToUse,
            referenceId: tx.id,
          },
          request,
        );
      }

      // Update matching serial number back to In Stock if exists
      const cleanSn = (assignment.serialNumber || "").trim();
      const snToMatch = cleanSn || assignment.id;
      await serialModel.findOneAndUpdate(
        {
          $or: [
            { serialNumber: cleanSn },
            { serialNumber: { $regex: new RegExp(`^${snToMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") } }
          ]
        },
        {
          $set: {
            status: "In Stock",
            assignedTo: "",
            assignedDate: "",
          },
        },
      );

      await createAuditLog(
        dbName,
        {
          action: "Asset Returned",
          category: "Assets",
          details: `Returned asset ${assignment.productName || assignment.productId} (${qty} units) from ${assignment.assignedTo} back to ${branchToUse} stock`,
          target: assignment.productName || assignment.assignedTo,
          branch: branchToUse,
          referenceId: id,
        },
        request,
      );

      return { success: true, data: assignment };
    } catch (error) {
      console.error("Error in PUT /assets/:id/return:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.get("/assets/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const record = await AssetAssignment(dbName).findOne({ id });
      if (!record) {
        return reply.status(404).send({ success: false, message: "Asset assignment not found" });
      }
      return { success: true, data: record };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/assets/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const assetModel = AssetAssignment(dbName);
      const existing = await assetModel.findOne({ id }).lean();
      if (!existing) {
        return reply.status(404).send({ success: false, message: "Asset assignment not found" });
      }

      const updated = await assetModel.findOneAndUpdate(
        { id },
        { $set: request.body },
        { new: true }
      );

      // Also sync serial number status / assignee if serial number is linked
      if (updated.serialNumber) {
        const serialModel = AssetSerial(dbName);
        await serialModel.findOneAndUpdate(
          { serialNumber: updated.serialNumber.trim() },
          {
            $set: {
              assignedTo: updated.assignedTo,
              branch: updated.branch || existing.branch,
            },
          }
        );
      }

      await createAuditLog(
        dbName,
        {
          action: "Asset Assignment Updated",
          category: "Assets",
          details: `Updated asset assignment ${id} for ${updated.productName} (Assigned To: ${updated.assignedTo}, Dept: ${updated.department || "N/A"}, Branch: ${updated.branch})`,
          target: updated.productName || updated.assignedTo,
          branch: updated.branch || "Global",
          referenceId: id,
          entityType: "AssetAssignment",
          previousState: existing,
          newState: updated.toObject ? updated.toObject() : updated,
        },
        request
      );

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/assets/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const assetModel = AssetAssignment(dbName);
      const deleted = await assetModel.findOneAndDelete({ id });
      if (!deleted) {
        return reply.status(404).send({ success: false, message: "Asset assignment not found" });
      }

      // If serial number was assigned, release it back to "In Stock"
      if (deleted.serialNumber) {
        const serialModel = AssetSerial(dbName);
        await serialModel.findOneAndUpdate(
          { serialNumber: deleted.serialNumber.trim() },
          {
            $set: {
              status: "In Stock",
              assignedTo: "",
              assignedDate: "",
            },
          }
        );
      }

      await createAuditLog(
        dbName,
        {
          action: "Asset Assignment Deleted",
          category: "Assets",
          details: `Deleted asset assignment ${id} (${deleted.productName} assigned to ${deleted.assignedTo})`,
          target: deleted.productName || deleted.assignedTo,
          branch: deleted.branch || "Global",
          referenceId: id,
          entityType: "AssetAssignment",
          previousState: deleted.toObject ? deleted.toObject() : deleted,
        },
        request
      );

      return { success: true, message: "Asset assignment deleted successfully", data: deleted };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // ── MAINTENANCE ──
  fastify.get("/maintenance", async (request, reply) => {
    const dbName = getDbName(request);
    const { branch, assetId, type, status } = request.query;

    const filter = {};
    if (assetId) filter.assetId = assetId;
    if (type && type !== "All") filter.type = type;
    if (status && status !== "All") filter.status = status;

    if (branch && branch !== "All") {
      const branchAssets = await AssetAssignment(dbName)
        .find({ branch })
        .select("id");
      filter.assetId = { $in: branchAssets.map((a) => a.id) };
    }

    const list = await Maintenance(dbName).find(filter).sort({ createdAt: -1 });
    return { success: true, data: list };
  });

  fastify.get("/maintenance/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    const record = await Maintenance(dbName).findOne({ id });
    if (!record)
      return reply
        .status(404)
        .send({ success: false, message: "Maintenance record not found" });
    return { success: true, data: record };
  });

  fastify.post("/maintenance", async (request, reply) => {
    const dbName = getDbName(request);
    try {
      const maintenanceModel = Maintenance(dbName);
      const count = await maintenanceModel.countDocuments();
      const nextId = `MNT-${String(count + 1).padStart(3, "0")}`;

      const created = await maintenanceModel.create({
        ...request.body,
        id: nextId,
      });

      await createAuditLog(
        dbName,
        {
          action: "Maintenance Scheduled",
          category: "Assets",
          details: `Scheduled maintenance ${created.id} for asset ${created.assetName || created.assetId} (${created.issueDescription || created.type || "Service"})`,
          target: created.assetName || created.id,
          branch: "Global",
          referenceId: created.id,
        },
        request,
      );

      return { success: true, data: created };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put("/maintenance/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    try {
      const updated = await Maintenance(dbName).findOneAndUpdate(
        { id },
        request.body,
        { new: true },
      );
      if (!updated)
        return reply
          .status(404)
          .send({ success: false, message: "Maintenance record not found" });

      await createAuditLog(
        dbName,
        {
          action: "Maintenance Updated",
          category: "Assets",
          details: `Updated maintenance record ${id} (Status: ${updated.status})`,
          target: updated.assetName || id,
          branch: "Global",
          referenceId: id,
        },
        request,
      );

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete("/maintenance/:id", async (request, reply) => {
    const dbName = getDbName(request);
    const { id } = request.params;
    await Maintenance(dbName).findOneAndDelete({ id });

    await createAuditLog(
      dbName,
      {
        action: "Maintenance Deleted",
        category: "Assets",
        details: `Deleted maintenance record ${id}`,
        target: id,
        branch: "Global",
        referenceId: id,
      },
      request,
    );

    return { success: true };
  });

  // ── ASSET SERIALS ──
  // GET all asset serials with filters & auto-reconciliation with active assignments
  fastify.get("/asset-serials", async (request, reply) => {
    const dbName = getDbName(request) || "m5c-inventory";
    const { productId, branch, serialNumber } = request.query;

    try {
      const AssetSerialModel = AssetSerial(dbName);
      const AssetAssignmentModel = AssetAssignment(dbName);

      // Auto-reconciliation: ensure every active AssetAssignment is reflected in AssetSerial
      const activeAssignments = await AssetAssignmentModel.find({ status: "Assigned" }).lean();
      
      for (const asgn of activeAssignments) {
        const cleanSn = (asgn.serialNumber || "").trim();
        const snToMatch = cleanSn || asgn.id;
        
        const existing = await AssetSerialModel.findOne({
          $or: [
            { serialNumber: cleanSn },
            { serialNumber: { $regex: new RegExp(`^${snToMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") } }
          ]
        });

        if (existing) {
          if (existing.status !== "Assigned" || existing.assignedTo !== asgn.assignedTo) {
            await AssetSerialModel.updateOne(
              { _id: existing._id },
              {
                $set: {
                  status: "Assigned",
                  assignedTo: asgn.assignedTo,
                  assignedDate: asgn.assignedDate ? asgn.assignedDate.slice(0, 10) : (existing.assignedDate || ""),
                  branch: asgn.branch || existing.branch,
                  model: asgn.modelNumber || existing.model || "",
                }
              }
            );
          }
        } else {
          // Auto-seed missing AssetSerial item so it appears in All Assets as Assigned
          const allSerials = await AssetSerialModel.find({}, { id: 1 }).lean();
          let maxNum = 0;
          for (const s of allSerials) {
            if (s.id && s.id.startsWith("AS-")) {
              const num = parseInt(s.id.replace("AS-", ""), 10);
              if (!isNaN(num) && num > maxNum) maxNum = num;
            }
          }
          const nextSerialId = `AS-${String(maxNum + 1).padStart(4, "0")}`;
          await AssetSerialModel.create({
            id: nextSerialId,
            productId: asgn.productId || "PROD-ASSET",
            productName: asgn.productName || "Asset Device",
            serialNumber: snToMatch,
            model: asgn.modelNumber || "",
            warranty: asgn.warranty || "",
            purchaseDate: asgn.assignedDate ? asgn.assignedDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
            invoiceNumber: "",
            supplier: "",
            branch: asgn.branch || "Ahmedabad",
            amount: 0,
            status: "Assigned",
            assignedTo: asgn.assignedTo,
            assignedDate: asgn.assignedDate ? asgn.assignedDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
            notes: asgn.notes || "",
          });
        }
      }

      const filter = {};
      if (productId) filter.productId = productId;
      if (branch && branch !== "All") filter.branch = branch;
      if (serialNumber) filter.serialNumber = serialNumber;

      const list = await AssetSerialModel.find(filter).sort({ createdAt: -1 });
      return { success: true, data: list };
    } catch (error) {
      console.error("Error fetching asset serials:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // GET serial numbers by product ID (for maintenance page)
  fastify.get("/asset-serials/product/:productId", async (request, reply) => {
    const dbName = getDbName(request) || "m5c-inventory";
    const { productId } = request.params;
    const { branch } = request.query;

    try {
      const AssetSerialModel = AssetSerial(dbName);
      const filter = { productId };
      if (branch && branch !== "All") {
        filter.branch = branch;
      }
      const list = await AssetSerialModel.find(filter).sort({ createdAt: -1 });
      return { success: true, data: list };
    } catch (error) {
      console.error("Error fetching serials by product:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // GET single asset serial by ID
  fastify.get("/asset-serials/:id", async (request, reply) => {
    const dbName = getDbName(request) || "m5c-inventory";
    const { id } = request.params;

    try {
      const AssetSerialModel = AssetSerial(dbName);
      const record = await AssetSerialModel.findOne({ id });
      if (!record) {
        return reply
          .status(404)
          .send({ success: false, message: "Asset serial not found" });
      }
      return { success: true, data: record };
    } catch (error) {
      console.error("Error fetching asset serial:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // POST create new asset serial
  fastify.post("/asset-serials", async (request, reply) => {
    const dbName = getDbName(request) || "m5c-inventory";
    const {
      productId,
      productName,
      serialNumber,
      model,
      warranty,
      purchaseDate,
      invoiceNumber,
      supplier,
      branch,
      amount,
      status,
      notes,
    } = request.body;

    const cleanSerial = (serialNumber || "").trim();
    if (!productId || !cleanSerial || !branch) {
      return reply.status(400).send({
        success: false,
        message: "ProductId, serialNumber, and branch are required",
      });
    }

    try {
      const AssetSerialModel = AssetSerial(dbName);

      // Check if serial already exists
      const existing = await AssetSerialModel.findOne({ serialNumber: cleanSerial });
      if (existing) {
        return reply.status(400).send({
          success: false,
          message: `Serial number ${cleanSerial} already exists`,
        });
      }

      // Generate unique ID based on max existing number
      const allSerials = await AssetSerialModel.find({}, { id: 1 }).lean();
      let maxNum = 0;
      for (const s of allSerials) {
        if (s.id && s.id.startsWith("AS-")) {
          const num = parseInt(s.id.replace("AS-", ""), 10);
          if (!isNaN(num) && num > maxNum) maxNum = num;
        }
      }
      const nextId = `AS-${String(maxNum + 1).padStart(4, "0")}`;

      const created = await AssetSerialModel.create({
        id: nextId,
        productId,
        productName: productName || "Asset",
        serialNumber: cleanSerial,
        model: model || "",
        warranty: warranty || "",
        purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
        invoiceNumber: invoiceNumber || "",
        supplier: supplier || "",
        branch,
        amount: !isNaN(Number(amount)) ? Number(amount) : 0,
        status: status || "In Stock",
        notes: notes || "",
      });

      await createAuditLog(
        dbName,
        {
          action: "Asset Serial Created",
          category: "Assets",
          details: `Registered serial number ${cleanSerial} for product ${created.productName} in branch ${branch}`,
          target: cleanSerial,
          branch,
          referenceId: created.id,
        },
        request,
      );

      return { success: true, data: created };
    } catch (error) {
      console.error("Error creating asset serial:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // PUT update asset serial
  fastify.put("/asset-serials/:id", async (request, reply) => {
    const dbName = getDbName(request) || "m5c-inventory";
    const { id } = request.params;

    try {
      const AssetSerialModel = AssetSerial(dbName);
      const AssetAssignmentModel = AssetAssignment(dbName);

      const existing = await AssetSerialModel.findOne({ id }).lean();
      if (!existing) {
        return reply
          .status(404)
          .send({ success: false, message: "Asset serial not found" });
      }

      const updated = await AssetSerialModel.findOneAndUpdate(
        { id },
        { $set: request.body },
        { new: true },
      );

      // Bidirectional sync with AssetAssignment
      const cleanSn = (updated.serialNumber || "").trim();
      if (updated.status === "Assigned" && updated.assignedTo) {
        // Sync or update assignment
        const existingAsgn = await AssetAssignmentModel.findOne({
          $or: [
            { serialNumber: cleanSn },
            { serialNumber: existing.serialNumber }
          ],
          status: "Assigned"
        });

        if (existingAsgn) {
          await AssetAssignmentModel.updateOne(
            { _id: existingAsgn._id },
            {
              $set: {
                serialNumber: cleanSn,
                assignedTo: updated.assignedTo,
                branch: updated.branch || existingAsgn.branch,
                modelNumber: updated.model || existingAsgn.modelNumber,
              }
            }
          );
        }
      } else if (updated.status !== "Assigned") {
        // If status changed away from Assigned, mark assignment as Returned
        await AssetAssignmentModel.updateMany(
          {
            $or: [
              { serialNumber: cleanSn },
              { serialNumber: existing.serialNumber }
            ],
            status: "Assigned"
          },
          {
            $set: {
              status: "Returned",
              returnedDate: new Date().toISOString(),
            }
          }
        );
      }

      await createAuditLog(
        dbName,
        {
          action: "Asset Serial Updated",
          category: "Assets",
          details: `Updated serial ${updated.serialNumber} (Model: ${updated.model || "N/A"}, Status: ${updated.status}${updated.assignedTo ? `, Assigned to: ${updated.assignedTo}` : ""})`,
          target: updated.serialNumber,
          branch: updated.branch || "Global",
          referenceId: id,
          entityType: "AssetSerial",
          previousState: existing,
          newState: updated.toObject ? updated.toObject() : updated,
        },
        request,
      );

      return { success: true, data: updated };
    } catch (error) {
      console.error("Error updating asset serial:", error);
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // DELETE asset serial
  fastify.delete("/asset-serials/:id", async (request, reply) => {
    const dbName = getDbName(request) || "m5c-inventory";
    const { id } = request.params;

    try {
      const AssetSerialModel = AssetSerial(dbName);
      const AssetAssignmentModel = AssetAssignment(dbName);
      const deleted = await AssetSerialModel.findOneAndDelete({ id });

      if (!deleted) {
        return reply.status(404).send({
          success: false,
          message: "Asset serial not found",
        });
      }

      // If deleted serial had active assignment, mark assignment returned
      if (deleted.serialNumber) {
        await AssetAssignmentModel.updateMany(
          { serialNumber: deleted.serialNumber.trim(), status: "Assigned" },
          {
            $set: {
              status: "Returned",
              returnedDate: new Date().toISOString(),
            }
          }
        );
      }

      await createAuditLog(
        dbName,
        {
          action: "Asset Serial Deleted",
          category: "Assets",
          details: `Deleted serial number ${deleted.serialNumber || id} (${deleted.productName || "Asset"})`,
          target: deleted.serialNumber || id,
          branch: deleted.branch || "Global",
          referenceId: id,
          entityType: "AssetSerial",
          previousState: deleted.toObject ? deleted.toObject() : deleted,
        },
        request,
      );

      return {
        success: true,
        message: "Asset serial deleted successfully",
        data: deleted,
      };
    } catch (error) {
      console.error("Delete asset serial error:", error);
      return reply.status(400).send({
        success: false,
        message: error.message,
      });
    }
  });
}
