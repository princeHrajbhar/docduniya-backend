import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

export const connectDB = async (): Promise<void> => {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
};

export const disconnectDB = async (): Promise<void> => {
  await mongoose.connection.close();
};
