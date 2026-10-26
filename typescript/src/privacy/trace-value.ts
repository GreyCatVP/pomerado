import { Buffer as NativeBuffer } from "node:buffer";
import { types } from "node:util";

const { isNativeError, isUint8Array, isMap, isSet, isProxy } = types;
const { getOwnPropertyDescriptor, getOwnPropertyDescriptors, getPrototypeOf } = Object;
const NativeError = Error;
const NativeUint8Array = Uint8Array;
const NativeWeakSet = WeakSet;
const bufferFrom = NativeBuffer.from;
const bufferText = NativeBuffer.prototype.toString;
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;

const excluded = (key: string, transportBoundary: boolean) => {
  const normalized = key.replaceAll(/[_-]/gu, "");
  return /^(?:authorization|auth|apiKey|accessToken|refreshToken|password|credentials?|toJSON)$|(?:headers|cookies)$/iu.test(normalized)
    || transportBoundary && /^(?:client|provider|modelProvider|config|configuration|options|request|response|socket|transport|requestOptions|requestBody|responseBody|body)$/iu.test(normalized);
};

const nativeStackGetter = getOwnPropertyDescriptor(new NativeError(), "stack")?.get;
const typedArrayGetter = (name: "buffer" | "byteOffset" | "byteLength") => {
  const getter = getOwnPropertyDescriptor(getPrototypeOf(NativeUint8Array.prototype), name)?.get;
  if (getter === undefined) throw new NativeError("Native byte-array accessor unavailable.");
  return getter;
};
const byteBuffer = typedArrayGetter("buffer");
const byteOffset = typedArrayGetter("byteOffset");
const byteLength = typedArrayGetter("byteLength");
const prepareStackTrace = getOwnPropertyDescriptor(NativeError, "prepareStackTrace");
const stackTextProperty = (value: object, key: string): boolean => {
  for (let object: object | null = value; object !== null; object = getPrototypeOf(object)) {
    if (isProxy(object)) return false;
    const descriptor = getOwnPropertyDescriptor(object, key);
    if (descriptor !== undefined) return "value" in descriptor && typeof descriptor.value === "string";
  }
  return true;
};
const trustedStackPreparation = () => {
  const globalError = getOwnPropertyDescriptor(globalThis, "Error");
  if (globalError === undefined || !("value" in globalError) || globalError.value !== NativeError) return false;
  const current = getOwnPropertyDescriptor(NativeError, "prepareStackTrace");
  if (prepareStackTrace === undefined) return current === undefined;
  return current !== undefined && "value" in current && "value" in prepareStackTrace
    && current.value === prepareStackTrace.value
    && current.writable === prepareStackTrace.writable
    && current.enumerable === prepareStackTrace.enumerable
    && current.configurable === prepareStackTrace.configurable;
};

export const traceValue = (value: unknown, redact: (text: string) => string): unknown => {
  const active = new NativeWeakSet<object>();
  const visit = (item: unknown, withinError = false): unknown => {
    if (typeof item === "string") return redact(item);
    if (typeof item === "bigint" || typeof item === "symbol") return redact(String(item));
    if (typeof item === "function") return "[function]";
    if (item === undefined) return "[undefined]";
    if (item === null || typeof item !== "object") return item;
    if (isProxy(item)) return "[proxy]";
    if (active.has(item)) return "[circular]";
    active.add(item);
    try {
      const nativeError = isNativeError(item);
      const transportBoundary = withinError || nativeError;
      if (isUint8Array(item)) {
        const bytes = bufferFrom(new NativeUint8Array(byteBuffer.call(item), byteOffset.call(item), byteLength.call(item)));
        const text = bufferText.call(bytes, "utf8");
        return { encoding: "base64", data: redact(bufferText.call(bufferFrom(redact(text) === text ? bytes : redact(text)), "base64")) };
      }
      if (isMap(item))
        return { entries: [...mapEntries.call(item)].filter(([key]) => typeof key !== "string" || !excluded(key, transportBoundary)).map(([key, entry]) => [visit(key, transportBoundary), visit(entry, transportBoundary)]) };
      if (isSet(item)) return { values: [...setValues.call(item)].map((entry) => visit(entry, transportBoundary)) };
      const descriptors = getOwnPropertyDescriptors(item);
      for (let prototype = transportBoundary ? getPrototypeOf(item) : null; prototype !== null; prototype = getPrototypeOf(prototype)) {
        if (isProxy(prototype)) return "[proxy]";
        const constructor = getOwnPropertyDescriptor(prototype, "constructor")?.value;
        const name = typeof constructor === "function" && !isProxy(constructor) ? getOwnPropertyDescriptor(constructor, "name")?.value : undefined;
        if (typeof name === "string" && /(?:Provider|Client|Request|Response|Socket|Transport|Headers|Cookies|OpenAI)$/u.test(name)) return "[excluded transport]";
      }
      if (["getModel", "getResponse", "getStreamedResponse"].some((key) => typeof descriptors[key]?.value === "function")) return "[excluded provider]";
      const type = descriptors["type"]?.value;
      if (type === "credential" || type === "secret") return { type };
      if (Array.isArray(item))
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          return descriptor !== undefined && "value" in descriptor ? visit(descriptor.value, transportBoundary) : "[accessor]";
        });
      const result: Record<string, unknown> = Object.create(null);
      if (nativeError) {
        result["name"] = "Error";
        for (let prototype = getPrototypeOf(item); prototype !== null; prototype = getPrototypeOf(prototype)) {
          const name = getOwnPropertyDescriptor(prototype, "name");
          if (name !== undefined && "value" in name && typeof name.value === "string") {
            result["name"] = redact(name.value);
            break;
          }
        }
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (excluded(key, transportBoundary)) continue;
        const nativeStack = key === "stack" && nativeError && nativeStackGetter !== undefined
          && descriptor.get === nativeStackGetter && stackTextProperty(item, "name") && stackTextProperty(item, "message")
          && trustedStackPreparation();
        result[redact(key)] = "value" in descriptor ? visit(descriptor.value, transportBoundary)
          : nativeStack ? visit(nativeStackGetter.call(item), transportBoundary) : "[accessor]";
      }
      return result;
    } finally {
      active.delete(item);
    }
  };
  return visit(value);
};
