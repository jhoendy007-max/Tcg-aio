// Save as src/stores/engine.ts
import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';

interface TaskSessionConfig {
    profileId: string;      // Unique ID for this task's container
    proxyServer?: string;    // e.g., "http://proxy.com"
    headlessMode: boolean;   // True for running completely silent in background
}

/**
 * Enterprise Orchestration Engine
 * Launches an isolated sandboxed context mirroring standard production architectures.
 */
export async function initializeTaskContext(config: TaskSessionConfig): Promise<{ context: BrowserContext; page: Page }> {
    // Point this to your local Clawbrowser executable path
    // Windows default installation path example:
    const clawbrowserPath = path.join(process.env.LOCALAPPDATA || '', 'Clawbrowser', 'Application', 'clawbrowser.exe');
    
    // Create an isolated storage vault for this specific task's cookies/session
    const userDataDir = path.join(process.cwd(), 'vault', 'profiles', config.profileId);

    const launchArgs = [
        `--user-data-dir=${userDataDir}`,
        '--disable-blink-features=AutomationControlled', // Native Chromium flag to reduce automation footprints
    ];

    if (config.proxyServer) {
        launchArgs.push(`--proxy-server=${config.proxyServer}`);
    }

    console.log(`[Engine] Initializing execution vault for Profile: ${config.profileId}...`);

    // Spawns a dedicated engine instance mimicking premium e-commerce solutions
    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: clawbrowserPath, 
        headless: config.headlessMode,
        args: launchArgs,
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    return { context, page };
}
