// 宿主会用 addInitScript 把整个函数送到页面，在镜头加载前执行。函数只依赖当前页面的内建对象。
export function installProxyRegistry() {
  const key = Symbol.for('beiming.three.isProxy');
  const installed = Object.getOwnPropertyDescriptor(globalThis, key);
  if (installed) {
    const has = installed.value;
    if (!installed.configurable && !installed.writable && typeof has === 'function' && Object.getOwnPropertyDescriptor(has, key)?.value === globalThis.Proxy) return has;
    throw new Error('二维舞台的 Proxy 登记标记冲突，请在未改写的页面中初始化');
  }

  const proxies = new WeakSet();
  const add = WeakSet.prototype.add.bind(proxies), has = WeakSet.prototype.has.bind(proxies);
  const NativeProxy = globalThis.Proxy, { construct, apply } = Reflect;
  // 用绑定函数承载包装器自己的静态属性，保留原构造器及其 revocable 的属性描述符。
  const wrapped = new NativeProxy(NativeProxy.bind(null), {
    construct(_, args, newTarget) {
      const proxy = construct(NativeProxy, args, newTarget);
      add(proxy);
      return proxy;
    },
  });
  const revocable = new NativeProxy(NativeProxy.revocable, {
    apply(fn, receiver, args) {
      const pair = apply(fn, receiver, args);
      add(pair.proxy);
      return pair;
    },
  });
  Object.defineProperties(wrapped, {
    name: Object.getOwnPropertyDescriptor(NativeProxy, 'name'),
    revocable: { ...Object.getOwnPropertyDescriptor(NativeProxy, 'revocable'), value: revocable },
  });
  Object.defineProperty(has, key, { value: wrapped });
  globalThis.Proxy = wrapped;
  Object.defineProperty(globalThis, key, { value: has });
  return has;
}
