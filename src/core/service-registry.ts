export class ServiceToken<T> {
  readonly label: string;
  private readonly _symbol: symbol;
  declare readonly _type: T; // phantom brand — compile-time only, zero runtime footprint

  constructor(label: string) {
    this.label = label;
    this._symbol = Symbol(label);
  }
}

export class ServiceRegistry {
  private readonly services = new Map<ServiceToken<unknown>, unknown>();

  register<T>(token: ServiceToken<T>, impl: T): void {
    if (this.services.has(token)) {
      throw new Error(`Service '${token.label}' is already registered. Each service token may only have one provider.`);
    }
    this.services.set(token, impl);
  }

  get<T>(token: ServiceToken<T>): T {
    if (!this.services.has(token)) {
      throw new Error(`Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin.`);
    }
    return this.services.get(token) as T;
  }
}
