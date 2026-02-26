node esbuild.config.js     # build TS → JS
cd web && npx vite build    # build React UI
cd ..
"$HOME/Library/Application Support/pear/bin/pear" stage .                # bundle for P2P distribution
"$HOME/Library/Application Support/pear/bin/pear" release .              # publish the release
# share the pear:// key
