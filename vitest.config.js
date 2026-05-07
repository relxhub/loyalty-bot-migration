import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: false,
        setupFiles: ['./tests/setup.js'],
        include: ['tests/**/*.test.js'],
        exclude: ['node_modules', 'tmp', '**/_*.test.js'],
        // หากภายหลังต้องการแยก unit/integration ให้รันแยก:
        //   npm test -- tests/unit
        //   npm test -- tests/integration
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'json-summary'],
            include: ['src/**/*.js'],
            exclude: [
                'src/**/*.test.js',
                'tests/**',
                'src/handlers/**',
                'src/jobs/**',
                'src/db.js',
                'src/config/config.js',
            ],
            thresholds: {
                // ค่อยเพิ่มทีละก้าวเมื่อมีเทสคลุมมากขึ้น
                statements: 0,
                branches: 0,
                functions: 0,
                lines: 0,
            },
        },
        testTimeout: 10000,
    },
});
