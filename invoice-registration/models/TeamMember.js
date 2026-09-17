import mongoose from 'mongoose';

const teamMemberSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['Master Admin', 'Admin', 'User', 'Verifier'], required: true },
}, { timestamps: true });

const getDb = () => mongoose.connection.useDb('m5-invoice-registration', { useCache: true });
const TeamMember = () => getDb().models.TeamMember || getDb().model('TeamMember', teamMemberSchema);

export default TeamMember;
