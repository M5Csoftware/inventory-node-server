import mongoose from 'mongoose';

const appConfigSchema = new mongoose.Schema({
  threshold: { type: Number, default: 50000 },
  currency: { type: String, enum: ['INR', 'USD', 'EUR'], default: 'INR' },
}, { timestamps: true });

const getDb = () => mongoose.connection.useDb('m5-invoice-registration', { useCache: true });
const AppConfig = () => getDb().models.AppConfig || getDb().model('AppConfig', appConfigSchema);

export default AppConfig;
