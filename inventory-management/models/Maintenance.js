import mongoose from "mongoose";

const maintenanceSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    assetId: { type: String, required: true },
    assetName: { type: String, required: true },
    serialNumber: { type: String, default: "" },
    type: {
      type: String,
      enum: ["Repair", "Replace", "Retire", "Dismantle"],
      required: true,
    },
    date: { type: String, required: true },
    cost: { type: Number, default: 0 },
    description: { type: String, default: "" },
    vendor: { type: String, default: "" },
    vendorContact: { type: String, default: "" },
    repairDetails: {
      issue: { type: String, default: "" },
      partsReplaced: [{ type: String }],
      laborCost: { type: Number, default: 0 },
      partsCost: { type: Number, default: 0 },
      estimatedTime: { type: String, default: "" },
      technician: { type: String, default: "" },
      warrantyClaim: { type: Boolean, default: false },
    },
    replaceDetails: {
      newProductId: { type: String, default: "" },
      newProductName: { type: String, default: "" },
      reason: { type: String, default: "" },
      disposalMethod: { type: String, default: "" },
    },
    retireDetails: {
      reason: { type: String, default: "" },
      disposalMethod: { type: String, default: "Scrap" },
      salvageValue: { type: Number, default: 0 },
      retiredBy: { type: String, default: "" },
    },
    dismantleDetails: {
      reason: { type: String, default: "" },
      partsRecovered: [{ type: String }],
      recoveryValue: { type: Number, default: 0 },
      disposalMethod: { type: String, default: "" },
      dismantledBy: { type: String, default: "" },
      location: { type: String, default: "" },
      environmentalNotes: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed", "Cancelled"],
      default: "Pending",
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

// Compound indexes for faster lookups
maintenanceSchema.index({ assetId: 1, date: -1 });
maintenanceSchema.index({ type: 1, status: 1 });

// Cache compiled models per-database
const modelCache = {};

const Maintenance = (dbName = "m5c-inventory") => {
  if (modelCache[dbName]) return modelCache[dbName];

  const connection = mongoose.connection.useDb(dbName, { useCache: true });
  const model =
    connection.models.Maintenance ||
    connection.model("Maintenance", maintenanceSchema);

  modelCache[dbName] = model;
  return model;
};

export default Maintenance;