{
  description = "Dev shell for pi extension development";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nixd
            nixfmt
            nodejs_20
            typescript
            tsx
            typescript-language-server
            eslint
            vscode-json-languageserver
            (writeShellScriptBin "babysitter" ''
              if [ -x "$PWD/node_modules/.bin/babysitter" ]; then
                exec "$PWD/node_modules/.bin/babysitter" "$@"
              fi

              SDK_VERSION=$(node -p "const pkg = require(\"./package.json\"); (pkg.devDependencies[\"@a5c-ai/babysitter-sdk\"] ?? \"\").replace(/^[^0-9]*/, \"\")")
              exec npx -y "@a5c-ai/babysitter-sdk@$SDK_VERSION" "$@"
            '')
          ];
        };
      }
    );
}
