import { initMonitor, checkDatabaseChanges } from '../services/monitor.service.js';

let ioInstance = null;

export const setSocketInstance = (io) => {
    ioInstance = io;
};

export const startMonitorJob = async () => {
    await initMonitor();

    // Check every 5 seconds (5000ms)
    // This is a good balance between responsiveness and load
    setInterval(async () => {
        if (!ioInstance) return;

        const events = await checkDatabaseChanges();
        
        if (events.length > 0) {
            console.log(`🕵️ Monitor: Found ${events.length} new events`);
            
            events.forEach(event => {
                // 1. Handle Critical Stock Updates (Real-time card update)
                if (event.type === 'RESTOCK' || event.type === 'OUT_OF_STOCK') {
                    ioInstance.emit('product_update', {
                        productId: event.data.id,
                        status: event.data.status
                    });
                }

                // 2. Handle Ticker Notifications (Banner)
                // Filter out OUT_OF_STOCK for ticker? Usually we advertise Good news.
                if (event.type !== 'OUT_OF_STOCK') {
                    ioInstance.emit('ticker_update', {
                        message: event.message,
                        type: event.type,
                        timestamp: Date.now()
                    });
                }
            });
        }
    }, 5000);
};
