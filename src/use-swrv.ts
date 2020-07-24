/**              ____
 *--------------/    \.------------------/
 *            /  swrv  \.               /    //
 *          /         / /\.            /    //
 *        /     _____/ /   \.         /
 *      /      /  ____/   .  \.      /
 *    /        \ \_____        \.   /
 *  /     .     \_____ \         \ /    //
 *  \          _____/ /        ./ /    //
 *    \       / _____/       ./  /
 *      \    / /      .    ./   /
 *        \ / /          ./    /
 *    .     \/         ./     /    //
 *            \      ./      /    //
 *              \.. /       /
 *         .     |||       /
 *               |||      /
 *     .         |||     /    //
 *               |||    /    //
 *               |||   /
 */
import {
  reactive,
  watch,
  ref,
  toRefs,
  isRef,
  onMounted,
  onUnmounted,
  onServerPrefetch,
  getCurrentInstance
} from '@vue/composition-api'
import isDocumentVisible from './lib/is-document-visible'
import isOnline from './lib/is-online'
import SWRVCache from './lib/cache'
import { IConfig, IKey, IResponse, fetcherFn } from './types'

const DATA_CACHE = new SWRVCache()
const REF_CACHE = new SWRVCache()
const PROMISES_CACHE = new SWRVCache()

const defaultConfig: IConfig = {
  cache: DATA_CACHE,
  refreshInterval: 0,
  ttl: 0,
  serverTTL: 1000,
  dedupingInterval: 2000,
  revalidateOnFocus: true,
  revalidateDebounce: 0
}

/**
 * Cache the refs for later revalidation
 */
function setRefCache (key, theRef, ttl) {
  const refCacheItem = REF_CACHE.get(key)
  if (refCacheItem) {
    refCacheItem.data.push(theRef)
  } else {
    // #51 ensures ref cache does not evict too soon
    const gracePeriod = 5000
    REF_CACHE.set(key, [theRef], ttl > 0 ? ttl + gracePeriod : ttl)
  }
}

/**
 * Main mutation function for receiving data from promises to change state and
 * set data cache
 */
const mutate = async <Data>(key: string, res: Promise<Data> | Data, cache = DATA_CACHE, ttl = defaultConfig.ttl) => {
  let data, error, isValidating

  if (isPromise(res)) {
    try {
      data = await res
    } catch (err) {
      error = err
    }
  } else {
    data = res
  }

  isValidating = false

  const newData = { data, error, isValidating }
  if (typeof data !== 'undefined') {
    cache.set(key, newData, ttl)
  }

  /**
   * Revalidate all swrv instances with new data
   */
  const stateRef = REF_CACHE.get(key)
  if (stateRef && stateRef.data.length) {
    // This filter fixes #24 race conditions to only update ref data of current
    // key, while data cache will continue to be updated if revalidation is
    // fired
    let refs = stateRef.data.filter(r => r.key === key)

    refs.forEach((r, idx) => {
      if (typeof newData.data !== 'undefined') {
        r.data = newData.data
      }
      if (newData.error) {
        r.error = newData.error
      }
      r.isValidating = newData.isValidating

      const isLast = idx === refs.length - 1
      if (!isLast) {
        // Clean up refs that belonged to old keys
        delete refs[idx]
      }
    })

    refs = refs.filter(Boolean)
  }

  return newData
}

type StateRef<Data, Error> = { data: Data, error: Error, isValidating: boolean, revalidate: Function, key: any };

/**
 * Stale-While-Revalidate hook to handle fetching, caching, validation, and more...
 */
export default function useSWRV<Data = any, Error = any> (key: IKey, fn?: fetcherFn<Data>, config?: IConfig): IResponse<Data, Error> {
  let unmounted = false
  let isHydrated = false

  const vm = getCurrentInstance() as any
  const IS_SERVER = vm.$isServer
  const isSsrHydration = Boolean(
    !IS_SERVER &&
    vm.$vnode &&
    vm.$vnode.elm &&
    vm.$vnode.elm.dataset &&
    vm.$vnode.elm.dataset.swrvKey)

  config = {
    ...defaultConfig,
    ...config
  }

  const ttl = IS_SERVER ? config.serverTTL : config.ttl
  const keyRef = typeof key === 'function' ? (key as any) : ref(key)

  let stateRef = null as StateRef<Data, Error>
  if (isSsrHydration) {
    // component was ssrHydrated, so make the ssr reactive as the initial data
    const swrvState = (window as any).__SWRV_STATE__ ||
      ((window as any).__NUXT__ && (window as any).__NUXT__.swrv) || []
    const swrvKey = +(vm as any).$vnode.elm.dataset.swrvKey

    if (swrvKey !== undefined && swrvKey !== null) {
      const nodeState = swrvState[swrvKey] || []
      const instanceState = nodeState[isRef(keyRef) ? keyRef.value : keyRef()]

      if (instanceState) {
        stateRef = reactive(instanceState)
        isHydrated = true
      }
    }
  }

  if (!stateRef) {
    stateRef = reactive({
      data: undefined,
      error: null,
      isValidating: true,
      key: null
    }) as StateRef<Data, Error>
  }

  /**
   * Revalidate the cache, mutate data
   */
  const revalidate = async (data?: fetcherFn<Data>) => {
    const keyVal = keyRef.value
    if (!isDocumentVisible() || !keyVal) { return }
    const cacheItem = config.cache.get(keyVal)
    let newData = cacheItem && cacheItem.data

    stateRef.isValidating = true
    if (newData) {
      stateRef.data = newData.data
      stateRef.error = newData.error
    }

    const fetcher = data || fn
    if (!fetcher) {
      stateRef.isValidating = false
      return
    }

    const trigger = async () => {
      const promiseFromCache = PROMISES_CACHE.get(keyVal)
      if (!promiseFromCache) {
        const newPromise = fetcher(keyVal)
        PROMISES_CACHE.set(keyVal, newPromise, config.dedupingInterval)
        await mutate(keyVal, newPromise, config.cache, ttl)
      } else {
        await mutate(keyVal, promiseFromCache.data, config.cache, ttl)
      }
      stateRef.isValidating = false
    }

    if (newData && config.revalidateDebounce) {
      await setTimeout(async () => {
        if (!unmounted) {
          await trigger()
        }
      }, config.revalidateDebounce)
    } else {
      await trigger()
    }

    PROMISES_CACHE.delete(keyVal)
  }

  const revalidateCall = async () => revalidate()
  let timer = null
  /**
   * Setup polling
   */
  onMounted(() => {
    const tick = async () => {
      // component might un-mount during revalidate, so do not set a new timeout
      // if this is the case, but continue to revalidate since promises can't
      // be cancelled and new hook instances might rely on promise/data cache or
      // from pre-fetch
      if (!stateRef.error && isDocumentVisible() && isOnline()) {
        // only revalidate when the page is visible
        // if API request errored, we stop polling in this round
        // and let the error retry function handle it
        await revalidate()
      } else {
        if (timer) {
          clearTimeout(timer)
        }
      }

      if (config.refreshInterval && !unmounted) {
        timer = setTimeout(tick, config.refreshInterval)
      }
    }

    if (config.refreshInterval) {
      timer = setTimeout(tick, config.refreshInterval)
    }
    if (config.revalidateOnFocus) {
      document.addEventListener('visibilitychange', revalidateCall, false)
      window.addEventListener('focus', revalidateCall, false)
    }
  })

  /**
   * Teardown
   */
  onUnmounted(() => {
    unmounted = true
    if (timer) {
      clearTimeout(timer)
    }
    if (config.revalidateOnFocus) {
      document.removeEventListener('visibilitychange', revalidateCall, false)
      window.removeEventListener('focus', revalidateCall, false)
    }
  })
  if (IS_SERVER) {
    // make sure srwv exists in ssrContext
    let swrvRes = []
    if (vm.$ssrContext) {
      swrvRes = vm.$ssrContext.swrv = vm.$ssrContext.swrv || swrvRes
    }

    const ssrKey = swrvRes.length
    if (!vm.$vnode || (vm.$node && !vm.$node.data)) {
      vm.$vnode = {
        data: { attrs: { 'data-swrv-key': ssrKey } }
      }
    }

    const attrs = (vm.$vnode.data.attrs = vm.$vnode.data.attrs || {})
    attrs['data-swrv-key'] = ssrKey

    // Nuxt compatibility
    if (vm.$ssrContext && vm.$ssrContext.nuxt) {
      vm.$ssrContext.nuxt.swrv = swrvRes
    }

    onServerPrefetch(async () => {
      await revalidate()

      if (!swrvRes[ssrKey]) swrvRes[ssrKey] = {}

      swrvRes[ssrKey][keyRef.value] = {
        data: stateRef.data,
        error: stateRef.error,
        isValidating: stateRef.isValidating
      }
    })
  }

  type WatcherOptionCompat = {
    lazy?: boolean;
    deep: boolean;
    immediate?: boolean
  }

  /**
   * Revalidate when key dependencies change
   */
  try {
    watch(keyRef, (val) => {
      keyRef.value = val
      stateRef.key = val
      setRefCache(keyRef.value, stateRef, ttl)

      if (!IS_SERVER && !isHydrated && keyRef.value) {
        revalidate()
      }
      isHydrated = false
      if (timer) {
        clearTimeout(timer)
      }
    }, {
      immediate: true
    } as Partial<WatcherOptionCompat>)
  } catch {
    // do nothing
  }

  return {
    ...toRefs(stateRef),
    mutate: revalidate
  } as IResponse<Data, Error>
}

function isPromise<T> (p: any): p is Promise<T> {
  return p !== null && typeof p === 'object' && typeof p.then === 'function'
}

export { mutate }
