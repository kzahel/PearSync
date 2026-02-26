node esbuild.config.js     # build TS → JS
cd web && npx vite build    # build React UI
cd ..
pear stage .                # bundle for P2P distribution
pear release .              # publish the release
# share the pear:// key
