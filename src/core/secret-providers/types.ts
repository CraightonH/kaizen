export interface SecretProvider {
  readonly name: string;
  get(ref: string): Promise<string | undefined>;
  set?(ref: string, value: string): Promise<void>;
  prefetch?(refs: string[]): Promise<void>;
}
