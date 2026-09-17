import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contact: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  location: { type: String, required: true },
  taxId: { type: String },
  website: { type: String },
}, { timestamps: true });

const Supplier = (dbName) => {
  const targetDbName = dbName || 'm5c-inventory';
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return db.models.Supplier || db.model('Supplier', supplierSchema);
};

export default Supplier;
