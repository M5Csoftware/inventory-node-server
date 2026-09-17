import mongoose from 'mongoose';

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: true },
  parentCategory: { type: String },
  categoryCode: { type: String },
  isAsset: { type: Boolean, default: false },
}, { timestamps: true });

const Category = (dbName) => {
  const targetDbName = dbName || 'm5c-inventory';
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return db.models.Category || db.model('Category', categorySchema);
};

export default Category;
