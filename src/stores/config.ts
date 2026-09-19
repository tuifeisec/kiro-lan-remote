/**
 * 配置 store：模型 / 思考程度 / 权限模式的权威渲染来源。
 * 对应开发文档 5.5。
 *
 * 关键原则：**所有选项从 Kiro 下发的 configOptions 原样渲染**，
 * 页面不根据模型名称推测是否支持思考程度。
 *
 * 「模型不支持 effortLevel 时隐藏按钮」的判据是：Kiro 是否下发了
 * id === 'effortLevel' 这一项 —— 切到 hasEffort:false 的模型时该项会整个消失。
 * 用「项是否存在」而非读模型 _meta.hasEffort，是因为前者连服务端都不用解释，
 * 最不容易失配。
 *
 * 契约 v2（多会话档位隔离）：status.configOptions 按 configSessionId 归档到
 * optionsBySession；页面显示的配置 = 「被查看会话」自己的条目，
 * 无条目时回退 status 的值。其他会话的推送不得覆盖当前显示。
 */

import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type { ConfigOption, ConfigOptionItem } from '../protocol/types';

/** 三个受支持的配置面板。 */
export type ConfigId = 'autopilot' | 'model' | 'effortLevel';

export const useConfigStore = defineStore('config', () => {
  /**
   * 各会话自己的配置条目。key 为 sessionId。
   * 契约 v2：status.configOptions 带 configSessionId，按会话归档，
   * 其他会话的推送不得覆盖当前显示。
   */
  const optionsBySession = shallowRef<Map<string, ConfigOption[]>>(new Map());
  /** 尚无任何会话条目时的全局兜底快照（最近一次 status/config-options 的值）。 */
  const fallbackOptions = shallowRef<ConfigOption[]>([]);
  /** 当前查看的会话；null 表示未查看任何会话（使用兜底）。 */
  const activeSessionId = ref<string | null>(null);
  const modelId = ref<string | null>(null);
  const modelName = ref<string | null>(null);

  /**
   * 当前生效的配置项 = 「被查看会话」自己的条目；
   * 被查看会话尚无条目时回退 status 的值。
   */
  const options = computed<ConfigOption[]>(() => {
    const sid = activeSessionId.value;
    if (sid) {
      const hit = optionsBySession.value.get(sid);
      if (hit) return hit;
    }
    return fallbackOptions.value;
  });

  /** 记录当前查看的会话（bootstrap 在 sessionId 变化时调用，含 immediate）。 */
  function setViewed(sessionId: string | null): void {
    activeSessionId.value = sessionId;
  }

  /**
   * 按归属会话归档一份配置条目。
   * 写入 optionsBySession 与全局兜底；**不**无条件覆盖当前显示 ——
   * 显示值由 options computed 依据被查看会话推导。
   */
  function absorbFor(sessionId: string | null, opts: ConfigOption[]): void {
    if (!opts.length) return;
    fallbackOptions.value = opts;
    if (sessionId) {
      const m = new Map(optionsBySession.value);
      m.set(sessionId, opts);
      optionsBySession.value = m;
    }
  }

  /**
   * 兼容入口：等价于 absorbFor(activeSessionId, options)。
   * 新代码请使用 absorbFor 以显式声明归属。
   */
  function absorb(options_: ConfigOption[]): void {
    absorbFor(activeSessionId.value, options_);
  }

  function configure(sessionId: string | null, opts: ConfigOption[], fallback: ConfigOption[]): void {
    activeSessionId.value = sessionId;
    fallbackOptions.value = fallback;
    if (sessionId && opts.length) {
      const m = new Map(optionsBySession.value);
      m.set(sessionId, opts);
      optionsBySession.value = m;
    }
  }

  function setModel(id: string | null, name: string | null): void {
    if (id) modelId.value = id;
    modelName.value = name;
  }

  /**
   * 本地权威回写：把 options 里 id === 'mode' 项的 currentValue 更新为 modeId。
   * 写回当前显示值的真实来源（被查看会话条目或全局兜底），
   * 等待服务端下次 pushStatus 校正。没有 mode 项时不做任何事。
   */
  function setModeValue(modeId: string): void {
    const cur = options.value;
    const idx = cur.findIndex((o) => o.id === 'mode');
    if (idx < 0) return;
    const updated = cur.slice();
    updated[idx] = { ...updated[idx], currentValue: modeId };
    if (activeSessionId.value && optionsBySession.value.get(activeSessionId.value) === cur) {
      const m = new Map(optionsBySession.value);
      m.set(activeSessionId.value, updated);
      optionsBySession.value = m;
    } else {
      fallbackOptions.value = updated;
    }
  }

  /** 按 id 取一条配置项；不存在返回 null（这是「不支持」的判据）。 */
  function cfg(id: ConfigId): ConfigOption | null {
    return options.value.find((o) => o.id === id) ?? null;
  }

  const modelOption = computed(() => cfg('model'));
  const effortOption = computed(() => cfg('effortLevel'));
  const autopilotOption = computed(() => cfg('autopilot'));

  const modelItems = computed<ConfigOptionItem[]>(() => {
    const m = modelOption.value;
    return (m?.options as ConfigOptionItem[] | undefined) ?? [];
  });

  /** 模型显示名：优先 configOptions 的 options，其次 status 的 modelName。 */
  function modelLabelOf(id: string | null): string | null {
    if (!id) return null;
    const hit = modelItems.value.find((o) => o.value === id);
    if (hit) return hit.name ?? id;
    return modelId.value === id ? modelName.value : null;
  }

  /** 某项配置的当前值 → 显示名。 */
  function optionName(opt: ConfigOption | null, value: string | undefined): string | null {
    if (!opt || !value) return null;
    const hit = (opt.options as ConfigOptionItem[] | undefined)?.find((o) => o.value === value);
    return hit?.name ?? null;
  }

  function currentOptionName(opt: ConfigOption | null): string | null {
    return opt ? optionName(opt, opt.currentValue) : null;
  }

  /**
   * 该会话是否支持调整思考程度。
   * 判据是「Kiro 是否下发了 effortLevel 项」，不是模型元数据。
   */
  const supportsEffort = computed(() => effortOption.value !== null);

  // ---------- 斜杠命令（按会话归档） ----------

  /** 各会话的斜杠命令列表（kind: 'commands' 事件驱动）。 */
  const commandsBySession = shallowRef<Map<string, unknown[]>>(new Map());

  function setCommands(sessionId: string | null, commands: unknown[]): void {
    if (!sessionId) return;
    const m = new Map(commandsBySession.value);
    m.set(sessionId, commands);
    commandsBySession.value = m;
  }

  /** 当前查看会话的命令列表；无记录时为空数组。 */
  const commands = computed<unknown[]>(() => {
    const sid = activeSessionId.value;
    return (sid && commandsBySession.value.get(sid)) || [];
  });

  return {
    optionsBySession,
    fallbackOptions,
    activeSessionId,
    modelId,
    modelName,
    options,
    commandsBySession,
    commands,
    modelOption,
    effortOption,
    autopilotOption,
    modelItems,
    supportsEffort,
    setViewed,
    absorbFor,
    configure,
    absorb,
    setModel,
    setModeValue,
    setCommands,
    cfg,
    modelLabelOf,
    optionName,
    currentOptionName,
  };
});
