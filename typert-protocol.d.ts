declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface RemoteErrorDetailsMap {}

  export type RemoteErrorCode = Extract<keyof RemoteErrorDetailsMap, string>

  export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
    readonly code: Code
    readonly details: RemoteErrorDetailsMap[Code]
    constructor(
      code: Code,
      message: string,
      details: RemoteErrorDetailsMap[Code],
      options?: ErrorOptions,
    )
  }

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }

  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}
  export interface TypertRemoteNamespaceMap {}

  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }

  export type TypertDisposer = () => Promise<void>

  export interface TypertClientRemote extends TypertRemoteNamespaceMap {
    $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  }

  export abstract class TypertRemoteService {
    protected readonly ctx: import('@deepseek-ai/cordis').Context
    protected constructor(
      ctx: import('@deepseek-ai/cordis').Context,
      serviceKey: string,
      options?: { readonly namespace?: string },
    )
  }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function Remote(option: string | { readonly mode: 'stream' }):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
