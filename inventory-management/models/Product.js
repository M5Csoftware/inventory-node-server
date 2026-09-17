import mongoose from 'mongoose';

const productSupplierSchema = new mongoose.Schema({
  supplierName: { type: String },
  rate: { type: Number }
}, { _id: false });

const productSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  branch: { type: String, default: 'Delhi' },
  stock: {
    Ahmedabad: { type: Number, default: 0 },
    Ludhiana: { type: Number, default: 0 },
    Delhi: { type: Number, default: 0 },
    Mumbai: { type: Number, default: 0 }
  },
  threshold: { type: Number, default: 10 },
  supplier: { type: String, required: true },
  suppliersList: [productSupplierSchema],
  sku: { type: String },
  description: { type: String },
  status: { type: String, default: 'active' },
  uomValue: { type: Number, default: 1 },
  uom: { type: String, default: 'pcs' },
  packaging: { type: String, default: 'boxes' },
  weight: { type: Number },
  dimensions: { type: String },
}, { timestamps: true, strict: false });

const Product = (dbName) => {
  const targetDbName = dbName || 'm5c-inventory';
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return db.models.Product || db.model('Product', productSchema);
};

export default Product;
