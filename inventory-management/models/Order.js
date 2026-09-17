import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true },
  supplier: { type: String, required: true },
  items: [{
    productId: { type: String, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    receivedQuantity: { type: Number, default: 0 }
  }],
  status: {
    type: String,
    enum: ['Pending', 'Processing', 'Partial', 'Completed', 'Cancelled'],
    default: 'Pending'
  },
  totalAmount: { type: Number, required: true },
  taxableAmount: { type: Number },
  taxSlab: { type: Number },
  taxOption: { type: String },
  taxAmount: { type: Number },
  termsAndConditions: { type: String },
  description: { type: String },
  branch: { type: String, required: true },
}, { timestamps: true });

const Order = (dbName) => {
  const targetDbName = dbName || 'm5c-inventory';
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return db.models.Order || db.model('Order', orderSchema);
};

export default Order;
