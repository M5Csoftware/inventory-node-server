import mongoose from "mongoose";

const AssetSerialSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
    },
    productId: {
      type: String,
      required: true,
      index: true,
    },
    productName: {
      type: String,
      required: true,
    },
    serialNumber: {
      type: String,
      required: true,
      unique: true,
    },
    model: {
      type: String,
      default: "",
    },
    warranty: {
      type: String,
      default: "",
    },
    purchaseDate: {
      type: String,
      default: "",
    },
    invoiceNumber: {
      type: String,
      default: "",
    },
    supplier: {
      type: String,
      default: "",
    },
    branch: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["In Stock", "Assigned", "Maintenance", "Retired", "Dismantled"],
      default: "In Stock",
    },
    notes: {
      type: String,
      default: "",
    },
    transactionId: {
      type: String,
      default: "",
    },
    assignedTo: {
      type: String,
      default: "",
    },
    assignedDate: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for faster lookups
AssetSerialSchema.index({ productId: 1, serialNumber: 1 });
AssetSerialSchema.index({ branch: 1, productId: 1 });

// Cache compiled models per-database
const modelCache = {};

const AssetSerial = (dbName = "m5c-inventory") => {
  if (modelCache[dbName]) return modelCache[dbName];

  const connection = mongoose.connection.useDb(dbName, { useCache: true });
  const model =
    connection.models.AssetSerial ||
    connection.model("AssetSerial", AssetSerialSchema);

  modelCache[dbName] = model;
  return model;
};

export default AssetSerial;