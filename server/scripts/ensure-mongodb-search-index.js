const fs = require("fs");
const path = require("path");

const template = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateSearchIndexOperation = void 0;
const responses_1 = require("../../cmap/wire_protocol/responses");
const operation_1 = require("../operation");
/** @internal */
class UpdateSearchIndexOperation extends operation_1.AbstractOperation {
    constructor(collection, name, definition) {
        super();
        this.SERVER_COMMAND_RESPONSE_TYPE = responses_1.MongoDBResponse;
        this.collection = collection;
        this.name = name;
        this.definition = definition;
        this.ns = collection.fullNamespace;
    }
    get commandName() {
        return 'updateSearchIndex';
    }
    buildCommand(_connection, _session) {
        const namespace = this.collection.fullNamespace;
        return {
            updateSearchIndex: namespace.collection,
            name: this.name,
            definition: this.definition
        };
    }
    handleOk(_response) {
        // no response.
    }
    buildOptions(timeoutContext) {
        return { session: this.session, timeoutContext };
    }
}
exports.UpdateSearchIndexOperation = UpdateSearchIndexOperation;
//# sourceMappingURL=update.js.map
`;

const bases = [
  path.join(__dirname, "..", "node_modules"),
  path.join(__dirname, "..", "..", "node_modules"),
];

let fixedAny = false;

for (const base of bases) {
  const mongodbDir = path.join(base, "mongodb");
  if (!fs.existsSync(mongodbDir)) {
    continue;
  }
  const targetPath = path.join(
    mongodbDir,
    "lib",
    "operations",
    "search_indexes",
    "update.js",
  );
  if (fs.existsSync(targetPath)) {
    continue;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, template, "utf8");
  fixedAny = true;
  console.log(
    "[postinstall] Restored mongodb search index update operation at",
    targetPath,
  );
}

if (!fixedAny) {
  console.log("[postinstall] MongoDB search index patch already present");
}
