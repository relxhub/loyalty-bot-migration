// scripts/migrate_product_levels.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * Maps a string value (e.g., "มาก", "ปานกลาง", "น้อย") to a numeric level (0-6).
 * This function can be customized to handle various string inputs.
 * @param {string | null | undefined} value The string value from the database.
 * @returns {number} A numeric value between 0 and 6.
 */
function mapStringToLevel(value) {
  if (!value) return 0;
  const lowerValue = value.toLowerCase().trim();

  // Handle high levels
  if (['มาก', 'high', '6', '5'].includes(lowerValue)) {
    return 5; // Max level can be 6, adjust as needed
  }
  // Handle medium levels
  if (['กลาง', 'ปานกลาง', 'medium', '3', '4'].includes(lowerValue)) {
    return 3;
  }
  // Handle low levels
  if (['น้อย', 'low', '1', '2'].includes(lowerValue)) {
    return 1;
  }
  // Default for unrecognized or empty strings
  return 0;
}

async function main() {
  console.log('Starting migration of product levels...');

  const productsToMigrate = await prisma.product.findMany({
    where: {
      OR: [
        { coolness: { not: null } },
        { sweetness: { not: null } },
        { flavorIntensity: { not: null } },
      ],
    },
  });

  if (productsToMigrate.length === 0) {
    console.log('No products found that need level migration. Exiting.');
    return;
  }

  console.log(`Found ${productsToMigrate.length} products to process.`);
  let migratedCount = 0;

  for (const product of productsToMigrate) {
    const newCoolnessLevel = mapStringToLevel(product.coolness);
    const newSweetnessLevel = mapStringToLevel(product.sweetness);
    const newFlavorIntensityLevel = mapStringToLevel(product.flavorIntensity);

    // Check if an update is actually needed to avoid unnecessary writes
    if (
      newCoolnessLevel !== product.coolnessLevel ||
      newSweetnessLevel !== product.sweetnessLevel ||
      newFlavorIntensityLevel !== product.flavorIntensityLevel
    ) {
      await prisma.product.update({
        where: { id: product.id },
        data: {
          coolnessLevel: newCoolnessLevel,
          sweetnessLevel: newSweetnessLevel,
          flavorIntensityLevel: newFlavorIntensityLevel,
        },
      });
      migratedCount++;
      console.log(`  -> Migrated levels for product: "${product.name}"`);
    }
  }

  console.log(`
Migration complete. Successfully migrated levels for ${migratedCount} products.`);
}

main()
  .catch((e) => {
    console.error('An error occurred during the migration script:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
