import AppConfig from './models/AppConfig.js';
import TeamMember from './models/TeamMember.js';
import Invoice from './models/Invoice.js';
import AuditLog from '../inventory-management/models/AuditLog.js';

// Helper to create audit logs for invoices in m5c-inventory
const createInvoiceAuditLog = async (logData, request = null) => {
  try {
    const auditModel = AuditLog('m5c-inventory');
    const count = await auditModel.countDocuments();
    const lastLog = await auditModel.findOne({ id: /^LOG-/ }).sort({ _id: -1 }).lean();
    let nextNum = count + 1001;
    if (lastLog && lastLog.id) {
      const parsed = parseInt(lastLog.id.replace('LOG-', ''), 10);
      if (!isNaN(parsed) && parsed >= nextNum) nextNum = parsed + 1;
    }
    const nextId = `LOG-${nextNum}`;

    return await auditModel.create({
      id: nextId,
      userName: logData.userName || "Master Admin",
      userEmail: logData.userEmail || "master@m5clogs.com",
      userRole: logData.userRole || "Admin",
      action: logData.action,
      category: "Invoice",
      details: logData.details,
      target: logData.target || "Invoice",
      branch: logData.branch || "Delhi",
      referenceId: logData.referenceId || "",
      entityType: "Invoice",
      previousState: logData.previousState || undefined,
      newState: logData.newState || undefined,
      timestamp: new Date().toISOString(),
      ipAddress: request?.ip || "127.0.0.1",
    });
  } catch (e) {
    console.error("createInvoiceAuditLog error:", e);
  }
};

export default async function invoiceRegistrationRoutes(fastify, options) {
  
  // ── CONFIG ROUTES ──
  fastify.get('/config', async (request, reply) => {
    let config = await AppConfig().findOne();
    if (!config) {
      config = await AppConfig().create({ threshold: 50000, currency: 'INR' });
    }
    return { success: true, data: config };
  });

  fastify.put('/config', async (request, reply) => {
    const updated = await AppConfig().findOneAndUpdate({}, request.body, { new: true, upsert: true });
    return { success: true, data: updated };
  });

  // ── TEAM ROUTES ──
  fastify.get('/team', async (request, reply) => {
    const team = await TeamMember().find();
    return { success: true, data: team };
  });

  fastify.post('/team', async (request, reply) => {
    const { id, name, username, password, role } = request.body;
    try {
      const newMember = await TeamMember().create({ id, name, username, password, role });
      return { success: true, data: newMember };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.put('/team/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      const updated = await TeamMember().findOneAndUpdate({ id }, request.body, { new: true });
      if (!updated) return reply.status(404).send({ success: false, message: 'Not found' });
      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  fastify.delete('/team/:id', async (request, reply) => {
    const { id } = request.params;
    await TeamMember().findOneAndDelete({ id });
    return { success: true };
  });

  // ── INVOICE ROUTES ──
  fastify.get('/invoices', async (request, reply) => {
    const { branch } = request.query || {};
    const query = {};
    if (branch && branch !== 'All') {
      query.branch = branch;
    }
    const invoices = await Invoice().find(query).sort({ createdAt: -1 });
    return { success: true, data: invoices };
  });

  fastify.post('/invoices', async (request, reply) => {
    try {
      const newInvoice = await Invoice().create(request.body);

      // Audit Log for Invoice Creation
      const invoiceBranch = newInvoice.branch || request.body.branch || "Delhi";
      await createInvoiceAuditLog({
        action: "Invoice Uploaded",
        details: `Uploaded inward invoice #${newInvoice.invoiceNumber} from vendor "${newInvoice.vendor}" (Total: ₹${(newInvoice.amount || 0).toLocaleString('en-IN')}) for branch "${invoiceBranch}"`,
        target: newInvoice.invoiceNumber || newInvoice.id,
        branch: invoiceBranch,
        referenceId: newInvoice.id,
        userName: newInvoice.enteredBy || "Master Admin",
        newState: newInvoice.toObject ? newInvoice.toObject() : newInvoice,
      }, request);

      return { success: true, data: newInvoice };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // Update invoice (used for verify, approve, reject, pay, bank details)
  fastify.put('/invoices/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      const existing = await Invoice().findOne({ id }).lean();
      if (!existing) return reply.status(404).send({ success: false, message: 'Not found' });

      const updated = await Invoice().findOneAndUpdate({ id }, request.body, { new: true });

      // Determine action name and details
      let action = "Invoice Updated";
      let details = `Updated invoice #${updated.invoiceNumber} (${updated.vendor})`;

      if (request.body.status && request.body.status !== existing.status) {
        if (request.body.status === 'pending_approval') {
          action = "Invoice Verified";
          details = `Verified invoice #${updated.invoiceNumber} (Advanced to Pending Approval)`;
        } else if (request.body.status === 'approved') {
          action = "Invoice Approved";
          details = `Approved invoice #${updated.invoiceNumber} for payment of ₹${(updated.amount || 0).toLocaleString('en-IN')}`;
        } else if (request.body.status === 'paid') {
          action = "Invoice Paid";
          details = `Marked invoice #${updated.invoiceNumber} as Paid`;
        } else if (request.body.status === 'rejected') {
          action = "Invoice Rejected";
          details = `Rejected invoice #${updated.invoiceNumber}`;
        }
      } else if (request.body.verificationNotes) {
        action = "Physical Verification";
        details = `Recorded physical verification count for invoice #${updated.invoiceNumber}`;
      } else if (request.body.bankDetails) {
        action = "Bank Details Added";
        details = `Added bank payout details for invoice #${updated.invoiceNumber}`;
      }

      await createInvoiceAuditLog({
        action,
        details,
        target: updated.invoiceNumber || id,
        branch: updated.branch || "Delhi",
        referenceId: id,
        userName: request.body.actorName || request.body.approvedBy || updated.enteredBy || "Master Admin",
        previousState: existing,
        newState: updated.toObject ? updated.toObject() : updated,
      }, request);

      return { success: true, data: updated };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });

  // Delete invoice
  fastify.delete('/invoices/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      const deleted = await Invoice().findOneAndDelete({ id });
      if (!deleted) return reply.status(404).send({ success: false, message: 'Not found' });

      await createInvoiceAuditLog({
        action: "Invoice Deleted",
        details: `Deleted invoice #${deleted.invoiceNumber} from vendor "${deleted.vendor}" (Amount: ₹${(deleted.amount || 0).toLocaleString('en-IN')})`,
        target: deleted.invoiceNumber || id,
        branch: deleted.branch || "Delhi",
        referenceId: id,
        previousState: deleted.toObject ? deleted.toObject() : deleted,
      }, request);

      return { success: true, message: "Invoice deleted successfully" };
    } catch (error) {
      return reply.status(400).send({ success: false, message: error.message });
    }
  });
}
