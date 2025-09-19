import { PayMCPOptions, PayToolConfig } from "../types/config.js";
import { McpServerLike } from "../types/mcp.js";
import { PaymentFlow } from "../types/payment.js";
import { buildProviders, ProviderInstances } from "../providers/index.js";
import { appendPriceToDescription } from "../utils/messages.js";
import { makeFlow } from "../flows/index.js";
import { StateStoreProvider, InMemoryStore } from "./state-store.js";

export class PayMCP {
    private server: McpServerLike;
    private providers: ProviderInstances;
    private flow: PaymentFlow;
    private wrapperFactory: ReturnType<typeof makeFlow>;
    private originalRegisterTool: McpServerLike["registerTool"];
    private stateStore: StateStoreProvider;
    private installed = false;

    constructor(server: McpServerLike, opts: PayMCPOptions) {
        this.server = server;
        this.providers = buildProviders(opts.providers as any);//TODO
        this.flow = opts.paymentFlow ?? PaymentFlow.TWO_STEP;
        this.wrapperFactory = makeFlow(this.flow);
        this.originalRegisterTool = server.registerTool.bind(server);
        // Initialize state store (default to InMemoryStore)
        this.stateStore = opts.stateStore || new InMemoryStore();
        console.log(`[PayMCP] Initialized with flow=${this.flow}, stateStore=${this.stateStore.constructor.name}`);
        this.patch();
        if (opts.retrofitExisting) {
            // Try to re-register existing tools (if SDK allows)
            this.retrofitExistingTools();
        }
    }

    /** Return server (useful for chaining) */
    getServer() {
        return this.server;
    }

    /** Remove patch (for tests / teardown) */
    uninstall() {
        if (!this.installed) return;
        (this.server as any).registerTool = this.originalRegisterTool;
        this.installed = false;
    }

    /** Main monkey-patch */
    private patch() {
        if (this.installed) return;
        const self = this;

        function patchedRegisterTool(
            name: string,
            config: PayToolConfig,
            handler: (...args: any[]) => Promise<any> | any
        ) {
            const price = config?.price;
            let wrapped = handler;

            if (price) {
                // pick the first provider (or a specific one by name? TBD)
                const provider = Object.values(self.providers)[0];
                if (!provider) {
                    throw new Error(`[PayMCP] No payment provider configured (tool: ${name}).`);
                }

                // append price to the description
                config = {
                    ...config,
                    description: appendPriceToDescription(config.description, price),
                };

                // wrap the handler in a payment flow
                wrapped = self.wrapperFactory(handler, self.server, provider, price, name, undefined, self.stateStore);
            }

            return self.originalRegisterTool(name, config, wrapped);
        }

        // Monkey-patch
        (this.server as any).registerTool = patchedRegisterTool;
        this.installed = true;
    }

    /**
     * Best-effort: go through already registered tools and re-wrap.
     * SDK may not have a public API; cautiously checking private fields.
     */
    private retrofitExistingTools() {
        const toolMap: Map<string, any> | undefined = (this.server as any)?.tools;
        if (!toolMap) return;

        for (const [name, entry] of toolMap.entries()) {
            const cfg: PayToolConfig = entry.config;
            const h = entry.handler;
            if (!cfg?.price) continue;

            // re-register using the patch (it will wrap automatically)
            (this.server as any).registerTool(name, cfg, h);
        }
    }
}

export function installPayMCP(server: McpServerLike, opts: PayMCPOptions): PayMCP {
    return new PayMCP(server, opts);
}