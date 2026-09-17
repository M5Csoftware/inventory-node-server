import mongoose from 'mongoose';

const assetAssignmentSchema = new mongoose.Schema({
  id: { type: String, required: true },
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  assignedTo: { type: String, required: true },
  assignedDate: { type: String, required: true },
  returnedDate: { type: String },
  status: { type: String, enum: ['Assigned', 'Returned'], default: 'Assigned', required: true },
  quantity: { type: Number, required: true, default: 1 },
  notes: { type: String },
  warranty: { type: String },
  modelNumber: { type: String },
  serialNumber: { type: String },
  branch: { type: String, enum: ['Ahmedabad', 'Ludhiana', 'Delhi', 'Mumbai'], required: true },
  department: { 
    type: String, 
    enum: ['Operations', 'Collections', 'Customer support', 'Sales support', 'Accounts', 'Billing', 'HR', 'Management'] 
  },
  approvedBy: { 
    type: String, 
    enum: ['Dheeraj', 'Chirag', 'Neha', 'Mandeep', 'Sangeeta', 'Rahul'] 
  },
}, { timestamps: true });

const AssetAssignment = (dbName) => {
  const targetDbName = dbName || 'm5c-inventory';
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return db.models.AssetAssignment || db.model('AssetAssignment', assetAssignmentSchema);
};

export default AssetAssignment;
