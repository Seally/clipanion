import {Coercion, LooseTest, StrictValidator} from 'typanion';

import {CommandBuilder, NoLimits, RunState} from '../core';
import { UsageError } from '../errors';

import {BaseContext, CliContext, MiniCli}   from './Cli';

const isOptionSymbol = Symbol(`clipanion/isOption`);

export type CommandOption<T> = {
    [isOptionSymbol]: true,
    definition: <Context extends BaseContext>(builder: CommandBuilder<CliContext<Context>>, key: string) => void,
    transformer: <Context extends BaseContext>(builder: CommandBuilder<CliContext<Context>>, key: string, state: RunState) => T,
};

export type CommandOptionReturn<T> = T;

function makeCommandOption<T>(spec: Omit<CommandOption<T>, typeof isOptionSymbol>) {
    // We lie! But it's for the good cause: the cli engine will turn the specs into proper values after instantiation.
    return {...spec, [isOptionSymbol]: true} as any as CommandOptionReturn<T>;
}

function rerouteArguments<A, B>(a: A | B, b: B): [Exclude<A, B>, B];
function rerouteArguments<A, B>(a: A | B | undefined, b: B): [Exclude<A, B> | undefined, B];
function rerouteArguments<A, B>(a: A | B | undefined, b: B): [Exclude<A, B>, B] {
    if (typeof a === `undefined`)
        return [a, b] as any;

    if (typeof a === `object` && a !== null && !Array.isArray(a)) {
        return [undefined, a as B] as any;
    } else {
        return [a, b] as any;
    }
}

function cleanValidationError(message: string, lowerCase: boolean = false) {
    let cleaned = message.replace(/^\.: /, ``);

    if (lowerCase)
        cleaned = cleaned[0].toLowerCase() + cleaned.slice(1);

    return cleaned;
}

function formatError(message: string, errors: string[]) {
    if (errors.length === 1) {
        return new UsageError(`${message}: ${cleanValidationError(errors[0], true)}`)
    } else {
        return new UsageError(`${message}:\n${errors.map(error => `\n- ${cleanValidationError(error)}`).join(``)}`)
    }
}

function applyValidator<U, V>(name: string, value: U, validator?: StrictValidator<unknown, V>) {
    if (typeof validator === `undefined`)
        return value;

    const errors: string[] = [];
    const coercions: Coercion[] = [];

    const check = validator(value, {errors, coercions, coercion: v => { value = v; }});
    if (!check) 
        throw formatError(`Invalid option validation for ${name}`, errors);

    for (const [, op] of coercions)
        op();

    return value;
}

export type GeneralFlags = {
    description?: string,
    hidden?: boolean,
};

export type ArrayFlags = GeneralFlags & {
    arity?: number,
};

export type StringOptionNoBoolean<T> = GeneralFlags & {
    validator?: StrictValidator<unknown, T>,
    tolerateBoolean?: false,
    arity?: number,
};

export type StringOptionTolerateBoolean<T> = GeneralFlags & {
    validator?: StrictValidator<unknown, T>,
    tolerateBoolean: boolean,
    arity?: 1,
};

export type StringOption<T> =
    | StringOptionNoBoolean<T>
    | StringOptionTolerateBoolean<T>;

export type StringPositionalFlags<T> = {
    validator?: StrictValidator<unknown, T>,
    name?: string,
    required?: boolean,
};

export type ProxyFlags = {
    name?: string,
    required?: number,
};

export type RestFlags = {
    name?: string,
    required?: number,
};

export type BooleanFlags = GeneralFlags;
export type CounterFlags = GeneralFlags;

/**
 * The usage of a Command.
 */
export type Usage = {
    /**
     * The category of the command.
     *
     * Included in the detailed usage.
     */
    category?: string;

    /**
     * The short description of the command, formatted as Markdown.
     *
     * Included in the detailed usage.
     */
    description?: string;

    /**
     * The extended details of the command, formatted as Markdown.
     *
     * Included in the detailed usage.
     */
    details?: string;

    /**
     * Examples of the command represented as an Array of tuples.
     *
     * The first element of the tuple represents the description of the example.
     *
     * The second element of the tuple represents the command of the example.
     * If present, the leading `$0` is replaced with `cli.binaryName`.
     */
    examples?: [string, string][];
};

/**
 * The definition of a Command.
 */
export type Definition = Usage & {
    /**
     * The path of the command, starting with `cli.binaryName`.
     */
    path: string;

    /**
     * The detailed usage of the command.
     */
    usage: string;

    /**
     * The various options registered on the command.
     */
    options: {
        definition: string;
        description?: string;
    }[];
};

export type CommandClass<Context extends BaseContext = BaseContext> = {
    new(): Command<Context>;
    paths?: string[][];
    schema?: LooseTest<{[key: string]: unknown}>[];
    usage?: Usage;
};

export abstract class Command<Context extends BaseContext = BaseContext> {
    /**
     * Paths under which the command should be exposed.
     */
    static paths?: string[][];

    /**
     * Defines the usage information for the given command.
     */
    static Usage(usage: Usage) {
        return usage;
    }

    /**
     * Contains the usage information for the command. If undefined, the
     * command will be hidden from the general listing.
     */
    static usage?: Usage;

    /**
     * Defines a schema to apply before running the `execute` method. The
     * schema is expected to be generated by Typanion.
     * 
     * @see https://github.com/arcanis/typanion
     */
    static schema?: LooseTest<{[key: string]: unknown}>[];

    /**
     * Standard function that'll get executed by `Cli#run` and `Cli#runExit`.
     * 
     * Expected to return an exit code or nothing (which Clipanion will treat
     * as if 0 had been returned).
     */
    abstract execute(): Promise<number | void>;

    /**
     * Standard error handler which will simply rethrow the error. Can be used
     * to add custom logic to handle errors from the command or simply return
     * the parent class error handling.
     */
    async catch(error: any): Promise<void> {
        throw error;
    }

    /**
     * Predefined that will be set to true if `-h,--help` has been used, in
     * which case `Command#execute` won't be called.
     */
    help: boolean = false;

    /**
     * Predefined variable that will be populated with a miniature API that can
     * be used to query Clipanion and forward commands.
     */
    cli!: MiniCli<Context>;

    /**
     * Predefined variable that will be populated with the context of the
     * application.
     */
    context!: Context;

    /**
     * Predefined variable that will be populated with the path that got used
     * to access the command currently being executed.
     */
    path!: string[];

    async validateAndExecute(): Promise<number> {
        const commandClass = this.constructor as CommandClass<Context>;
        const cascade = commandClass.schema;

        if (typeof cascade !== `undefined`) {
            const {isDict, isUnknown, applyCascade} = await import(`typanion`);
            const schema = applyCascade(isDict(isUnknown()), cascade);

            const errors: string[] = [];
            const coercions: Coercion[] = [];

            const check = schema(this, {errors, coercions});
            if (!check)
                throw formatError(`Invalid option schema`, errors);

            for (const [, op] of coercions) {
                op();
            }
        }

        const exitCode = await this.execute();
        if (typeof exitCode !== `undefined`) {
            return exitCode;
        } else {
            return 0;
        }
    }

    /**
     * Used to detect option definitions.
     */
    static isOption: typeof isOptionSymbol = isOptionSymbol;

    /**
     * Just an helper to use along with the `path` / paths` fields, to make it
     * clearer that a command is the default one.
     * 
     * @example
     * class MyCommand extends Command {
     *   static path = Command.Default;
     * }
     * 
     * @example
     * class MyCommand extends Command {
     *   static paths = [Command.Default];
     * }
     */
    static Default = [];

    /**
     * Used to annotate array options. Such options will be strings unless they
     * are provided a schema, which will then be used for coercion.
     * 
     * @example
     * --foo hello --foo bar
     *     ► {"foo": ["hello", "world"]}
     */
    static Array(descriptor: string, opts?: ArrayFlags): CommandOptionReturn<string[] | undefined>;
    static Array(descriptor: string, initialValue: string[], opts?: ArrayFlags): CommandOptionReturn<string[]>;
    static Array(descriptor: string, initialValueBase: ArrayFlags | string[] | undefined, optsBase?: ArrayFlags) {
        const [initialValue, opts] = rerouteArguments(initialValueBase, optsBase ?? {});
        const {arity = 1} = opts;

        const optNames = descriptor.split(`,`);
        const nameSet = new Set(optNames);

        return makeCommandOption({
            definition(builder) {
                builder.addOption({
                    names: optNames,
                    
                    arity,
                    
                    hidden: opts?.hidden,
                    description: opts?.description,
                });
            },

            transformer(builder, key, state) {
                let currentValue = typeof initialValue !== `undefined`
                    ? [...initialValue]
                    : undefined;

                for (const {name, value} of state.options) {
                    if (!nameSet.has(name))
                        continue;

                    currentValue = currentValue ?? [];
                    currentValue.push(value);
                }

                return currentValue;
            }
        });
    }

    /**
     * Used to annotate boolean options.
     * 
     * @example
     * --foo --no-bar
     *     ► {"foo": true, "bar": false}
     */
    static Boolean(descriptor: string, opts?: BooleanFlags): CommandOptionReturn<boolean | undefined>;
    static Boolean(descriptor: string, initialValue: boolean, opts?: BooleanFlags): CommandOptionReturn<boolean>;
    static Boolean(descriptor: string, initialValueBase: BooleanFlags | boolean | undefined, optsBase?: BooleanFlags) {
        const [initialValue, opts] = rerouteArguments(initialValueBase, optsBase ?? {});

        const optNames = descriptor.split(`,`);
        const nameSet = new Set(optNames);

        return makeCommandOption({
            definition(builder) {
                builder.addOption({
                    names: optNames,

                    allowBinding: false,
                    arity: 0,

                    hidden: opts.hidden,
                    description: opts.description,
                });
            },

            transformer(builer, key, state) {
                let currentValue = initialValue;

                for (const {name, value} of state.options) {
                    if (!nameSet.has(name))
                        continue;

                    currentValue = value;
                }

                return currentValue;
            }
        });
    }

    /**
     * Used to annotate options whose repeated values are aggregated into a
     * single number.
     * 
     * @example
     * -vvvvv
     *     ► {"v": 5}
     */
    static Counter(descriptor: string, opts?: CounterFlags): CommandOptionReturn<number | undefined>;
    static Counter(descriptor: string, initialValue: number, opts?: CounterFlags): CommandOptionReturn<number>;
    static Counter(descriptor: string, initialValueBase: CounterFlags | number | undefined, optsBase?: CounterFlags) {
        const [initialValue, opts] = rerouteArguments(initialValueBase, optsBase ?? {});

        const optNames = descriptor.split(`,`);
        const nameSet = new Set(optNames);

        return makeCommandOption({
            definition(builder) {
                builder.addOption({
                    names: optNames,

                    allowBinding: false,
                    arity: 0,

                    hidden: opts.hidden,
                    description: opts.description,
                });
            },

            transformer(builder, key, state) {
                let currentValue = initialValue;

                for (const {name, value} of state.options) {
                    if (!nameSet.has(name))
                        continue;

                    currentValue ??= 0;

                    // Negated options reset the counter
                    if (!value) {
                        currentValue = 0;
                    } else {
                        currentValue += 1;
                    }
                }

                return currentValue;
            }
        });
    }

    /**
     * Used to annotate positional options. Such options will be strings
     * unless they are provided a schema, which will then be used for coercion.
     * 
     * Be careful: this function is order-dependent! Make sure to define your
     * positional options in the same order you expect to find them on the
     * command line.
     */
    static String(): CommandOptionReturn<string>;
    static String<T = string>(opts: Omit<StringPositionalFlags<T>, 'required'>): CommandOptionReturn<T>;
    static String<T = string>(opts: StringPositionalFlags<T> & {required: false}): CommandOptionReturn<T | undefined>;
    static String<T = string>(opts: StringPositionalFlags<T>): CommandOptionReturn<T | undefined>;

    /**
     * Used to annotate string options. Such options will be typed as strings
     * unless they are provided a schema, which will then be used for coercion.
     * 
     * @example
     * --foo=hello --bar world
     *     ► {"foo": "hello", "bar": "world"}
     */
    static String<T = string>(descriptor: string, opts?: StringOptionTolerateBoolean<T>): CommandOptionReturn<T | boolean | undefined>;
    static String<T = string>(descriptor: string, initialValue: string | boolean, opts?: StringOptionTolerateBoolean<T>): CommandOptionReturn<T | boolean>;
    static String<T = string>(descriptor: string, opts?: StringOptionNoBoolean<T>): CommandOptionReturn<T | undefined>;
    static String<T = string>(descriptor: string, initialValue: string, opts?: StringOptionNoBoolean<T>): CommandOptionReturn<T>;

    // This function is badly typed, but it doesn't matter because the overloads provide the true public typings
    static String(descriptor?: unknown, ...args: any[]) {
        if (typeof descriptor === `string`) {
            return Command.StringOption(descriptor, ...args);
        } else {
            return Command.StringPositional(descriptor as any);
        }
    }

    /**
     * @internal
     */
    static StringOption<T = string>(descriptor: string, opts?: StringOptionTolerateBoolean<T>): CommandOptionReturn<T | boolean | undefined>;
    static StringOption<T = string>(descriptor: string, initialValue: string | boolean, opts?: StringOptionTolerateBoolean<T>): CommandOptionReturn<T | boolean>;
    static StringOption<T = string>(descriptor: string, opts?: StringOptionNoBoolean<T>): CommandOptionReturn<T | undefined>;
    static StringOption<T = string>(descriptor: string, initialValue: string, opts?: StringOptionNoBoolean<T>): CommandOptionReturn<T>;
    static StringOption<T = string>(descriptor: string, initialValueBase: StringOption<T> | string | boolean | undefined, optsBase?: StringOption<T>) {
        const [initialValue, opts] = rerouteArguments(initialValueBase, optsBase ?? {});
        const {arity = 1} = opts;

        const optNames = descriptor.split(`,`);
        const nameSet = new Set(optNames);

        return makeCommandOption({
            definition(builder) {
                builder.addOption({
                    names: optNames,

                    arity: opts.tolerateBoolean ? 0 : arity,

                    hidden: opts.hidden,
                    description: opts.description,
                });
            },

            transformer(builder, key, state) {
                let currentValue = initialValue;

                for (const {name, value} of state.options) {
                    if (!nameSet.has(name))
                        continue;

                    currentValue = value;
                }

                return applyValidator(key, currentValue, opts.validator);
            }
        });
    }

    /**
     * @internal
     */
    static StringPositional(): CommandOptionReturn<string>;
    static StringPositional<T = string>(opts: Omit<StringPositionalFlags<T>, 'required'>): CommandOptionReturn<T>;
    static StringPositional<T = string>(opts: StringPositionalFlags<T> & {required: false}): CommandOptionReturn<T | undefined>;
    static StringPositional<T = string>(opts: StringPositionalFlags<T>): CommandOptionReturn<T | undefined>;
    static StringPositional<T = string>(opts: StringPositionalFlags<T> = {}) {
        const {required = true} = opts;

        return makeCommandOption({
            definition(builder, key) {
                builder.addPositional({
                    name: opts.name ?? key,
                    required: opts.required,
                });
            },

            transformer(builder, key, state) {
                for (let i = 0; i < state.positionals.length; ++i) {
                    // We skip NoLimits extras. We only care about
                    // required and optional finite positionals.
                    if (state.positionals[i].extra === NoLimits)
                        continue;

                    // We skip optional positionals when we only
                    // care about required positionals.
                    if (required && state.positionals[i].extra === true)
                        continue;

                    // We skip required positionals when we only
                    // care about optional positionals.
                    if (!required && state.positionals[i].extra === false)
                        continue;

                    // We remove the positional from the list
                    const [positional] = state.positionals.splice(i, 1);

                    return positional.value;
                }
            }
        });
    }

    /**
     * Used to annotate that the command wants to retrieve all trailing
     * arguments that cannot be tied to a declared option.
     * 
     * Be careful: this function is order-dependent! Make sure to define it
     * after any positional argument you want to declare.
     * 
     * This function is mutually exclusive with Command.Rest.
     *
     * @example
     * yarn run foo hello --foo=bar world
     *     ► proxy = ["hello", "--foo=bar", "world"]
     */
    static Proxy(opts: ProxyFlags = {}) {
        return makeCommandOption({
            definition(builder, key) {
                builder.addProxy({
                    name: opts.name ?? key,
                    required: opts.required,
                });
            },

            transformer(builder, key, state) {
                return state.positionals.map(({value}) => value);
            }
        });
    }

    /**
     * Used to annotate that the command supports any number of positional
     * arguments.
     * 
     * Be careful: this function is order-dependent! Make sure to define it
     * after any positional argument you want to declare.
     * 
     * This function is mutually exclusive with Command.Proxy.
     * 
     * @example
     * yarn add hello world
     *     ► rest = ["hello", "world"]
     */
    static Rest(opts: RestFlags = {}) {
        return makeCommandOption({
            definition(builder, key) {
                builder.addRest({
                    name: opts.name ?? key,
                    required: opts.required,
                });
            },

            transformer(builder, key, state) {
                // The builder's arity.extra will always be NoLimits,
                // because it is set when we call registerDefinition

                const isRestPositional = (index: number) => {
                    const positional = state.positionals[index];

                    // A NoLimits extra (i.e. an optional rest argument)
                    if (positional.extra === NoLimits)
                        return true;

                    // A leading positional (i.e. a required rest argument)
                    if (positional.extra === false && index < builder.arity.leading.length)
                        return true;

                    return false;
                };

                let count = 0;
                while (count < state.positionals.length && isRestPositional(count))
                    count += 1;

                return state.positionals.splice(0, count).map(({value}) => value);
            }
        });
    }

    /**
     * A list of useful semi-opinionated command entries that have to be registered manually.
     *
     * They cover the basic needs of most CLIs (e.g. help command, version command).
     *
     * @example
     * cli.register(Command.Entries.Help);
     * cli.register(Command.Entries.Version);
     */
    static Entries = {
        /**
         * A command that prints the clipanion definitions.
         */
        Definitions: class DefinitionsCommand extends Command<any> {
            static path = [[`--clipanion=definitions`]];
            async execute() {
                this.context.stdout.write(`${JSON.stringify(this.cli.definitions(), null, 2)}\n`);
            }
        },

        /**
         * A command that prints the usage of all commands.
         *
         * Paths: `-h`, `--help`
         */
        Help: class HelpCommand extends Command<any> {
            static paths = [[`-h`], [`--help`]];
            async execute() {
                this.context.stdout.write(this.cli.usage(null));
            }
        },

        /**
         * A command that prints the version of the binary (`cli.binaryVersion`).
         *
         * Paths: `-v`, `--version`
         */
        Version: class VersionCommand extends Command<any> {
            static paths = [[`-v`], [`--version`]];
            async execute() {
                this.context.stdout.write(`${this.cli.binaryVersion ?? `<unknown>`}\n`);
            }
        },
    };
}
