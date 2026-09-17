import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  id: { type: String, required: true },
  userName: { type: String, required: true },
  userEmail: { type: String },
  userRole: { type: String },
  action: { type: String, required: true }, // e.g. 'Stock In', 'Product Created', 'User Updated'
  category: { type: String, required: true }, // 'Stock', 'Products', 'Orders', 'Users', 'System', 'Categories', 'Assets', 'Suppliers', 'Invoice'
  details: { type: String, required: true },
  target: { type: String },
  branch: { type: String, default: 'Global' },
  ipAddress: { type: String, default: '127.0.0.1' },
  referenceId: { type: String },
  // Rollback / Revert tracking
  entityType: { type: String }, // 'Product', 'Transaction', 'Transfer', 'Order', 'Supplier', 'Category', 'Asset', 'Invoice'
  previousState: { type: mongoose.Schema.Types.Mixed },
  newState: { type: mongoose.Schema.Types.Mixed },
  isReverted: { type: Boolean, default: false },
  revertedAt: { type: Date },
  revertedBy: { type: String },
  revertReason: { type: String },
  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });

export default (dbName) => {
  const db = mongoose.connection.useDb(dbName || 'm5c-inventory');
  return db.models.AuditLog || db.model('AuditLog', auditLogSchema);
};
