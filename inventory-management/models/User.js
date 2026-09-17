import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: { type: String, required: true, select: false },
  role: {
    type: String,
    enum: ['admin', 'stock_manager', 'invoice_manager', 'custom', 'master'],
    default: 'stock_manager',
  },
  branch: {
    type: String,
    enum: ['All', 'Ahmedabad', 'Ludhiana', 'Delhi', 'Mumbai'],
    default: 'Ahmedabad',
  },
  permissions: {
    type: [String],
    default: [],
  },
  lastLogin: { type: Date },
}, { timestamps: true });

// Plain-text comparison (no hashing for now to simplify setup)
userSchema.methods.comparePassword = function (candidate) {
  return candidate === this.password;
};

const User = (dbName) => {
  const targetDbName = dbName || 'm5c-inventory';
  const db = mongoose.connection.useDb(targetDbName, { useCache: true });
  return db.models.User || db.model('User', userSchema);
};

export default User;