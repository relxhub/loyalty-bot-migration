// validate_migration.js
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'url';

const prisma = new PrismaClient();

// Helper function to count rows in a CSV file
async function getCsvRowCount(filePath) {
    if (!fs.existsSync(filePath)) {
        return 0;
    }
    let count = 0;
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', () => count++)
            .on('end', () => resolve(count))
            .on('error', reject);
    });
}

// Helper function to compare values, handling type differences
function areValuesEqual(csvValue, dbValue) {
    if (csvValue === null || typeof csvValue === 'undefined') csvValue = '';
    if (dbValue === null || typeof dbValue === 'undefined') dbValue = '';

    // If dbValue is a Date, convert csvValue to a comparable format
    if (dbValue instanceof Date) {
        if (!csvValue) return false; // CSV date is empty
        const csvDate = new Date(csvValue);
        // Compare time in milliseconds
        return csvDate.getTime() === dbValue.getTime();
    }

    // For numbers, Prisma returns numbers, CSV parser returns strings
    if (typeof dbValue === 'number') {
        return dbValue === Number(csvValue);
    }
    
    // For booleans
    if (typeof dbValue === 'boolean') {
        return dbValue === (csvValue.toLowerCase() === 'true');
    }

    return String(csvValue).trim() === String(dbValue).trim();
}

/**
 * Validates data migrated from CustomerData.csv against the Customer table in the database.
 */
async function validateCustomers() {
    console.log('\n--- Starting Customer Data Validation ---');
    const filePath = './CustomerData.csv';
    let mismatches = 0;
    let validatedCount = 0;

    // 1. Count Validation
    console.log('1. Performing Count Validation...');
    const csvRowCount = await getCsvRowCount(filePath);
    const dbRecordCount = await prisma.customer.count({ where: { isDeleted: false }}});

    if (csvRowCount !== dbRecordCount) {
        console.error(`❌ COUNT MISMATCH! CSV rows: ${csvRowCount}, DB records: ${dbRecordCount}`);
        // We can choose to stop here if counts don't match, as it's a major issue.
        return; 
    }
    console.log(`✅ Count validation passed. (${csvRowCount} records)`);

    // 2. Row-by-Row Content Validation
    console.log('2. Performing Row-by-Row Content Validation...');
    
    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', async (row) => {
                try {
                    const customerId = row.customerId;
                    if (!customerId) return;

                    const dbCustomer = await prisma.customer.findUnique({
                        where: { customerId: customerId },
                    });

                    if (!dbCustomer) {
                        console.error(`- [${customerId}] ❌ MISMATCH: Record not found in DB.`);
                        mismatches++;
                        return;
                    }

                    // Fields to check [CSV_Column_Name, DB_Field_Name, isOptional]
                    const fieldsToCompare = [
                        ['points', 'points'],
                        ['firstName', 'firstName'],
                        ['lastName', 'lastName'],
                        ['username', 'username'],
                        ['telegramUserId', 'telegramUserId'],
                        ['referrerId', 'referrerId'],
                        ['expiryDate', 'expiryDate'],
                        ['joinDate', 'joinDate']
                    ];
                    
                    let hasError = false;
                    for (const [csvField, dbField] of fieldsToCompare) {
                        const csvValue = row[csvField] || '';
                        const dbValue = dbCustomer[dbField] || '';
                        
                        if (!areValuesEqual(csvValue, dbValue)) {
                            if (!hasError) { // Print header only on first error for this user
                                console.log(`- [${customerId}] ❌ MISMATCH found:`);
                                hasError = true;
                            }
                            console.log(`    - Field '${dbField}': CSV='${csvValue}' | DB='${dbValue}'`);
                            mismatches++;
                        }
                    }
                    validatedCount++;
                    if(validatedCount % 100 === 0) process.stdout.write('.');

                } catch (error) {
                    console.error(`\nAn error occurred while processing row for ${row.customerId}:`, error);
                    mismatches++;
                }
            })
            .on('end', () => {
                console.log('\nValidation process finished.');
                if (mismatches === 0) {
                    console.log('✅ All customer records match perfectly!');
                } else {
                    console.error(`❌ Found a total of ${mismatches} mismatches.`);
                }
                resolve();
            })
            .on('error', reject);
    });
}

async function main() {
    console.log('Starting migration validation script...');
    
    // You can add calls to other validation functions here
    await validateCustomers();
    // await validateAdmins();
    // await validateRewards();
    // ... etc. 

    await prisma.$disconnect();
    console.log('\nValidation script finished.');
}

main().catch(e => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
});
