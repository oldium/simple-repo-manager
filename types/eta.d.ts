export * from "eta";

import type { Eta as EtaEta, EtaConfig, Options } from "eta";

declare module "eta" {
    export type TemplateFunction = (this: Eta, data?: object, options?: Partial<Options>) => string;
    declare class Eta extends EtaEta {
        // Just minimal fixes to make it work with TypeScript
        constructor(customConfig?: Partial<EtaConfig>);
        config: EtaConfig;
        compile(this: EtaEta, str: string, options?: Partial<Options>): TemplateFunction;
        render<T extends object>(this: EtaEta, template: string | TemplateFunction,
            data: T, meta?: {
                filepath: string;
            }): string;
        loadTemplate(name: string, template: string | TemplateFunction,
            // template string or template function
            options?: {
                async: boolean;
            }): void;
    }
}
