export interface ViewportMutationPolicy {
    allowInPlaceRecovery: boolean;
    allowViewportNormalization: boolean;
}
export declare function parseBooleanEnvFlag(value: string | undefined, defaultValue: boolean): boolean;
export declare function readViewportMutationPolicy(env?: NodeJS.ProcessEnv): ViewportMutationPolicy;
