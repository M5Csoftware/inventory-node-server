import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  date: { type: String, required: true },
  purchaseDate: { type: String }, // Store the purchase date from the Stock In form
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  type: { type: String, enum: ['Stock In', 'Stock Out'], required: true },
  quantity: { type: Number, required: true },
  reasonOrLocation: { type: String },
  notes: { type: String },
  branch: { type: String, required: true },
  amount: { type: Number }, // Store the amount/price from the form
  supplier: { type: String }, // Store the supplier
  invoiceNumber: { type: String }, // Store invoice number
  model: { type: String }, // Store model
  serialNumber: { type: String }, // Store serial number
}, { timestamps: true });

export default (dbName) => {
  const db = mongoose.connection.useDb(dbName);
  return db.model('Transaction', transactionSchema);
};