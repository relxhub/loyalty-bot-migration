import { PrismaClient } from '@prisma/client';
import https from 'https';

const prisma = new PrismaClient();

// Reliable source: A complete and flat Thai address JSON (Subdistrict, District, Province, Zipcode)
const DATA_URL = 'https://raw.githubusercontent.com/kongvut/thai-province-data/master/api/latest/sub_district_with_district_and_province.json';

async function main() {
    console.log('--- STARTING COMPREHENSIVE THAI ADDRESS SEED ---');
    
    try {
        console.log('Step 1: Fetching data from GitHub...');
        
        const fetchData = () => new Promise((resolve, reject) => {
            https.get(DATA_URL, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(JSON.parse(data)));
            }).on('error', reject);
        });

        const rawData = await fetchData();
        console.log(`Fetched ${rawData.length} sub-districts.`);

        console.log('Step 2: Clearing existing data...');
        await prisma.thaiAddress.deleteMany({});

        console.log('Step 3: Preparing data for insertion (7,000+ records)...');
        // Structure based on Kongvut dataset: { name_th, zip_code, amphure: { name_th, province: { name_th } } }
        const formattedData = rawData.map(item => ({
            subdistrict: item.name_th,
            district: item.amphure?.name_th || 'N/A',
            province: item.amphure?.province?.name_th || 'N/A',
            zipcode: item.zip_code?.toString() || '00000'
        }));

        console.log('Step 4: Inserting into database (1,000 records per batch)...');
        const chunkSize = 1000;
        for (let i = 0; i < formattedData.length; i += chunkSize) {
            const chunk = formattedData.slice(i, i + chunkSize);
            await prisma.thaiAddress.createMany({
                data: chunk,
                skipDuplicates: true
            });
            console.log(`Progress: ${Math.min(i + chunkSize, formattedData.length)} / ${formattedData.length} records...`);
        }

        console.log('--- SUCCESS: THAI ADDRESS BOOK IS COMPLETE ---');
        console.log(`Total records in database: ${formattedData.length}`);

    } catch (error) {
        console.error('SEEDING FAILED:', error);
        process.exit(1);
    }
}

main().finally(async () => { await prisma.$disconnect(); });
