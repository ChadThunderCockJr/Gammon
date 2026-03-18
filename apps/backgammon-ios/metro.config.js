const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch all files in the monorepo (needed for workspace packages)
config.watchFolders = [monorepoRoot];

// Resolve packages from both the app and the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Force "react" imports to resolve to the app-local React 19 copy,
// not the root monorepo React 18.
const appReactPath = path.resolve(projectRoot, "node_modules/react");

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react") {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(appReactPath, "package.json"), "utf8"));
    return { type: "sourceFile", filePath: path.resolve(appReactPath, pkgJson.main || "index.js") };
  }
  if (moduleName.startsWith("react/")) {
    const subpath = moduleName.slice(6);
    const fullPath = path.resolve(appReactPath, subpath);
    for (const candidate of [fullPath, fullPath + ".js", fullPath + ".json", fullPath + "/index.js"]) {
      if (fs.existsSync(candidate)) {
        return { type: "sourceFile", filePath: candidate };
      }
    }
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
