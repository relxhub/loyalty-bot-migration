// src/db.js
import { PrismaClient } from '@prisma/client';

let prisma;

try {
    prisma = new PrismaClient();
    console.log("🟢 PrismaClient initialized successfully.");
} catch (error) {
    console.error("🔴 Fatal Error: Could not initialize PrismaClient.");
    console.error("Please ensure DATABASE_URL is set correctly in your environment variables.");
    console.error(error);
    process.exit(1); // Exit the application if Prisma client cannot be initialized
}

export { prisma };