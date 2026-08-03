declare module 'aiplug' {
  export function createLLMAdapter(options: any): any;
  export function createLLM(options: any): any;
  export function listProviders(): string[];
  export function getProvider(name: string): any;
  const _aiplug: any;
  export default _aiplug;
}