
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function repairReferrals() {
    console.log("⏳ Starting referral repair process...");

    try {
        const logPath = path.join(process.cwd(), 'admin_logs.csv');
        const referralMap = new Map();
        let restoredLinks = 0;

        if (fs.existsSync(logPath)) {
            const fileContent = fs.readFileSync(logPath, 'utf-8');
            const lines = fileContent.split('\n');

            console.log(`📄 Processing ${lines.length} log lines...`);

            for (const line of lines) {
                // Simple regex to capture CREATE_CUSTOMER and Referred by
                const createMatch = line.match(/CREATE_CUSTOMER,([A-Z0-9]+)/);
                const refMatch = line.match(/Referred by: ([A-Z0-9]+)/);

                if (createMatch && refMatch) {
                    const childId = createMatch[1].trim().toUpperCase();
                    const referrerId = refMatch[1].trim().toUpperCase();

                    if (childId && referrerId && referrerId !== 'N/A') {
                        referralMap.set(childId, referrerId);
                    }
                }
            }

            console.log(`🔍 Found ${referralMap.size} referral relationships in logs.`);

            for (const [childId, referrerId] of referralMap) {
                const child = await prisma.customer.findUnique({ where: { customerId: childId } });

                if (child && !child.referrerId) {
                    // Check if referrer exists
                    const referrer = await prisma.customer.findUnique({ where: { customerId: referrerId } });
                    if (referrer) {
                        await prisma.customer.update({
                            where: { customerId: childId },
                            data: { referrerId: referrerId }
                        });
                        process.stdout.write('.');
                        restoredLinks++;
                    }
                }
            }
            console.log(`\n✅ Restored ${restoredLinks} missing referral links.`);
        } else {
            console.log("❌ admin_logs.csv not found.");
        }

    } catch (error) {
        console.error("❌ Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

repairReferrals();
