import mongoose from 'mongoose';

const flagSchema = new mongoose.Schema({
  level: { type: String, enum: ['high', 'medium', 'low'] },
  text: String,
}, { _id: false });

const approvalSchema = new mongoose.Schema({
  by: String,
  at: Number,
}, { _id: false });

const historyEntrySchema = new mongoose.Schema({
  at: Number,
  actorId: String,
  actorName: String,
  actorRole: String,
  action: String,
  note: String,
}, { _id: false });

const bankDetailsSchema = new mongoose.Schema({
  bankName: String,
  accountName: String,
  accountNumber: String,
  ifscCode: String,
  addedAt: Number,
  addedBy: String,
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  vendor: { type: String, required: true },
  invoiceNumber: { type: String, required: true },
  invoiceDate: { type: String, required: true },
  taxableAmount: { type: Number, required: true },
  taxSlab: { type: Number },
  taxOption: { type: String, enum: ['IGST', 'CGST_SGST'] },
  taxAmount: { type: Number, required: true },
  amount: { type: Number, required: true },
  poNumber: String,
  branch: { type: String, default: 'Ahmedabad' },
  bankLast4: String,
  bankDetails: bankDetailsSchema,
  description: String,
  invoiceImage: String,
  invoiceImages: [String],
  enteredBy: { type: String, required: true },
  enteredAt: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending_verification', 'pending_approval', 'approved', 'paid', 'rejected'],
    default: 'pending_verification'
  },
  approvals: [approvalSchema],
  history: [historyEntrySchema],
  flags: [flagSchema],
  verificationNotes: String,
}, { timestamps: true });

const getDb = () => mongoose.connection.useDb('m5-invoice-registration', { useCache: true });
const Invoice = () => getDb().models.Invoice || getDb().model('Invoice', invoiceSchema);

export default Invoice;
