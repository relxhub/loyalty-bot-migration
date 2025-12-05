// scripts/repair_referral_transactions.js
import { PrismaClient } from '@prisma/client';
import { getConfig, loadConfig } from '../src/config/config.js';

const prisma = new PrismaClient();

async function repairData() {
    console.log("🚀 Starting referral data repair process...");
    
    // Load config to get standard bonus points
    await loadConfig();
    const bonusPoints = parseInt(getConfig('standardReferralPoints')) || 50;
    console.log(`ℹ️ Using standard bonus of ${bonusPoints} points.`);

    // 1. Find all customers who have referred someone
    const referrers = await prisma.customer.findMany({
        where: {
            referralCount: {
                gt: 0
            }
        },
        select: {
            customerId: true,
            referralCount: true,
        }
    });

    if (referrers.length === 0) {
        console.log("✅ No referrers found. Data is consistent.");
        return;
    }

    console.log(`🔍 Found ${referrers.length} referrers with referral counts > 0. Analyzing...`);
    let transactionsCreated = 0;
    let pointsAwarded = 0;

    // 2. For each referrer, check their referees
    for (const referrer of referrers) {
        process.stdout.write(`\nChecking referrer: ${referrer.customerId}... `);

        const referees = await prisma.customer.findMany({
            where: {
                referrerId: referrer.customerId
            }
        });

        // 3. For each referee, check if a PointTransaction exists
        for (const referee of referees) {
            const existingTransaction = await prisma.pointTransaction.findFirst({
                where: {
                    customerId: referrer.customerId,
                    type: 'REFERRAL_BONUS',
                    detail: {
                        contains: referee.customerId
                    }
                }
            });

            // 4. If transaction does not exist, create it and update points
            if (!existingTransaction) {
                try {
                    // Use a transaction to ensure both operations succeed or fail together
                    await prisma.$transaction([
                        // a. Create the missing PointTransaction
                        prisma.pointTransaction.create({
                            data: {
                                customerId: referrer.customerId,
                                amount: bonusPoints,
                                type: 'REFERRAL_BONUS',
                                detail: `[REPAIR] From new customer ${referee.customerId}`,
                                createdAt: referee.joinDate // Use the referee's join date as the transaction date
                            }
                        }),
                        // b. Update the referrer's points
                        prisma.customer.update({
                            where: {
                                customerId: referrer.customerId
                            },
                            data: {
                                points: {
                                    increment: bonusPoints
                                }
                            }
                        })
                    ]);
                    
                    process.stdout.write(`✅ Repaired for ${referee.customerId}. `);
                    transactionsCreated++;
                    pointsAwarded += bonusPoints;

                } catch (e) {
                    process.stdout.write(`❌ FAILED to repair for ${referee.customerId}: ${e.message} `);
                }
            } else {
                process.stdout.write(`(Skipped ${referee.customerId}) `);
            }
        }
    }

    console.log("\n\n🎉 Repair process complete!");
    console.log(`- Transactions Created: ${transactionsCreated}`);
    console.log(`- Total Points Awarded: ${pointsAwarded}`);
}

repairData()
    .catch(e => {
        console.error("An error occurred during the repair process:", e);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
