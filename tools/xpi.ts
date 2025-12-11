// eslint-disable-next-line @typescript-eslint/no-var-requires
const xpiModule = require("xpi");
import { tmpdir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, statSync, copyFileSync } from "fs";

// Download the xpi files from the urls in the urls.json file
const urlsFile = Bun.file("./src/urls.json");

/**
 * Downloads an XPI file from a URL and returns it as an ArrayBuffer
 * @param url - The URL of the XPI file to download
 * @returns The downloaded file as an ArrayBuffer, or null if download failed
 */
async function downloadXPI(url: string): Promise<ArrayBuffer | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
            return null;
        }
        return response.arrayBuffer();
    } catch (error) {
        console.error(`Error downloading ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * Extracts the extension ID from an XPI file's manifest.json
 * @param xpiFilePath - The file path to the XPI file
 * @returns The extension ID, or null if not found
 */
async function getExtensionId(xpiFilePath: string): Promise<string | null> {
    try {
        // Read the XPI file as a ZIP archive
        const xpiFile = Bun.file(xpiFilePath);
        const buffer = await xpiFile.arrayBuffer();
        // Use Bun's built-in ZIP support or extract manually
        // For now, let's use a simple approach: read the file and extract manifest.json
        // Bun doesn't have built-in ZIP support, so we'll use a different approach
        // We can use the xpi package to read the manifest, or extract it manually
        // Let's try using Bun's file system to read it as a ZIP
        const tempDir = join(tmpdir(), `xpi-extract-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });
        // Use Bun's spawn to extract manifest.json
        const proc = Bun.spawn(["unzip", "-p", xpiFilePath, "manifest.json"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const manifestText = await new Response(proc.stdout).text();
        await proc.exited;
        if (proc.exitCode !== 0) {
            console.error(`Failed to extract manifest.json: ${await new Response(proc.stderr).text()}`);
            return null;
        }
        try {
            const manifest = JSON.parse(manifestText);
            // Try manifest v2 format: applications.gecko.id
            if (manifest.applications?.gecko?.id) {
                return manifest.applications.gecko.id;
            }
            // Try manifest v3 format: browser_specific_settings.gecko.id
            if (manifest.browser_specific_settings?.gecko?.id) {
                return manifest.browser_specific_settings.gecko.id;
            }
            console.error("Could not find extension ID in manifest.json");
            return null;
        } catch (parseError) {
            console.error(`Failed to parse manifest.json: ${parseError}`);
            return null;
        }
    } catch (error) {
        console.error(`Error extracting extension ID: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * Processes an XPI file using the xpi package's SourceEmitter
 * This extracts scripts and overlays from the XPI file
 * @param xpiFilePath - The file path to the XPI file
 * @returns A promise that resolves when processing is complete
 */
async function processXPI(xpiFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const xpiInstance = new xpiModule.SourceEmitter(xpiFilePath);
        const scripts: Array<{ fileName: string; source: string }> = [];
        const overlays: Array<{ fileName: string; source: string }> = [];
        xpiInstance.on("script", (script: { fileName: string; source: string }) => {
            scripts.push(script);
            console.log(`Found script: ${script.fileName}`);
        });
        xpiInstance.on("overlay", (overlay: { fileName: string; source: string }) => {
            overlays.push(overlay);
            console.log(`Found overlay: ${overlay.fileName}`);
        });
        xpiInstance.on("end", () => {
            console.log(`Processing complete. Found ${scripts.length} scripts and ${overlays.length} overlays.`);
            resolve();
        });
        xpiInstance.on("error", (error: Error) => {
            console.error(`Error processing XPI: ${error instanceof Error ? error.message : String(error)}`);
            reject(error);
        });
    });
}

/**
 * Downloads XPI files from URLs and processes them
 * Downloads each file to a temporary location, processes it, then cleans up
 */
async function installXPIFromUrls(): Promise<void> {
    if (!(await urlsFile.exists())) {
        console.error("urls.json file not found");
        process.exit(1);
    }
    try {
        const urls = JSON.parse(await urlsFile.text());
        console.log(urls);
        for (const url of urls.urls) {
            const xpiFileBuffer = await downloadXPI(url);
            if (xpiFileBuffer) {
                // Create a temporary file path
                const tempFilePath = join(tmpdir(), `xpi-${Date.now()}-${Math.random().toString(36).substring(7)}.xpi`);
                // Write the buffer to the temporary file
                await Bun.write(tempFilePath, xpiFileBuffer);
                console.log(`Downloaded XPI file: ${url}`);
                try {
                    // Process the XPI file
                    await processXPI(tempFilePath);
                    console.log(`Processed XPI file: ${url}`);

                    // Install the XPI file
                    const profilesIniPath = resolve(process.env.HOME || "", ".mozilla/firefox/profiles.ini");
                    if (!existsSync(profilesIniPath)) {
                        console.error("profiles.ini file not found");
                        process.exit(1);
                    }
                    const profilesContent = await Bun.file(profilesIniPath).text();
                    if (!profilesContent) {
                        console.error("profiles.ini file is empty");
                        process.exit(1);
                    }
                    // Parse profiles.ini to find the default profile
                    // Format: [Install...] section has Default=profileName
                    // Or [ProfileX] sections have Path=profileName and Default=1
                    let profileName: string | null = null;
                    const lines = profilesContent.split("\n");
                    // First, try to find Default= in [Install...] section
                    let inInstallSection = false;
                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith("[Install")) {
                            inInstallSection = true;
                        } else if (trimmedLine.startsWith("[")) {
                            inInstallSection = false;
                        } else if (inInstallSection && trimmedLine.startsWith("Default=")) {
                            const parts = trimmedLine.split("=");
                            const defaultValue = parts[1];
                            if (defaultValue !== undefined) {
                                profileName = defaultValue.trim();
                                break;
                            }
                        }
                    }
                    // If not found, look for profile with Default=1
                    if (!profileName) {
                        let currentProfilePath: string | null = null;
                        for (const line of lines) {
                            const trimmedLine = line.trim();
                            if (trimmedLine.startsWith("[Profile")) {
                                currentProfilePath = null;
                            } else if (trimmedLine.startsWith("Path=")) {
                                const parts = trimmedLine.split("=");
                                const pathValue = parts[1];
                                if (pathValue !== undefined) {
                                    currentProfilePath = pathValue.trim();
                                }
                            } else if (trimmedLine.startsWith("Default=1") && currentProfilePath) {
                                profileName = currentProfilePath;
                                break;
                            }
                        }
                    }
                    if (!profileName) {
                        console.error("Could not find default profile in profiles.ini");
                        process.exit(1);
                    }
                    // Resolve the profile directory (handle both relative and absolute paths)
                    const firefoxDir = resolve(process.env.HOME || "", ".mozilla/firefox");
                    const profileDirectory = resolve(firefoxDir, profileName);
                    const xpiDirectory = resolve(profileDirectory, "extensions");
                    // Check if profile directory exists
                    if (!existsSync(profileDirectory)) {
                        console.error(`Profile directory not found: ${profileDirectory}`);
                        process.exit(1);
                    }
                    // Check if extensions directory exists, create it if it doesn't
                    if (!existsSync(xpiDirectory)) {
                        console.log(`Creating extensions directory: ${xpiDirectory}`);
                        mkdirSync(xpiDirectory, { recursive: true });
                    } else {
                        // Verify it's actually a directory
                        const stats = statSync(xpiDirectory);
                        if (!stats.isDirectory()) {
                            console.error(`extensions path exists but is not a directory: ${xpiDirectory}`);
                            process.exit(1);
                        }
                    }
                    console.log(`Extensions directory ready: ${xpiDirectory}`);
                    // Extract extension ID from the XPI file
                    const extensionId = await getExtensionId(tempFilePath);
                    if (!extensionId) {
                        console.error("Could not extract extension ID from XPI file");
                        process.exit(1);
                    }
                    console.log(`Extension ID: ${extensionId}`);
                    // Determine the target filename (extension ID.xpi)
                    const targetXpiPath = resolve(xpiDirectory, `${extensionId}.xpi`);
                    // Copy the XPI file to the extensions directory
                    copyFileSync(tempFilePath, targetXpiPath);
                    console.log(`Installed XPI file to: ${targetXpiPath}`);
                    // Clean up the temporary file
                    try {
                        await Bun.file(tempFilePath).unlink();
                    } catch (cleanupError) {
                        console.warn(`Failed to delete temporary file ${tempFilePath}: ${cleanupError}`);
                    }
                } catch (error) {
                    console.error("Error installing XPI file");
                    console.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                }
            }
        }
    } catch (error) {
        console.error("Error processing XPI file");
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

export { downloadXPI, processXPI, installXPIFromUrls }; 