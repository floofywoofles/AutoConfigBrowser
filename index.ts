import { installXPIFromUrls } from "./tools/xpi";

await installXPIFromUrls().then(() => {
    console.log("XPI files installed successfully");
}).catch((error) => {
    console.error("Error installing XPI files");
    console.error(error);
    process.exit(1);
});