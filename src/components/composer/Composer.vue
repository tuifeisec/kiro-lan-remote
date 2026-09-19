<script setup lang="ts">
/**
 * 输入区：固定底部、圆角深色面板、自动高度、模型/思考程度/权限模式选择、
 * 执行中发送按钮切换为取消、'/' 斜杠命令菜单。
 *
 * 关键约束：
 *   - 输入字号不得小于 16px（CSS 保证，否则 iOS 聚焦会整页放大）；
 *   - 模型不支持 effortLevel 时**隐藏**该按钮（不是禁用）；
 *   - Ctrl/Cmd+Enter 发送；执行中该快捷键不重复触发发送；
 *   - 斜杠菜单打开时 ↑↓ 选择、Enter 插入「命令 + 空格」、Esc 只收起菜单
 *     （阻止冒泡，避免 ConversationView 的 Escape 链把用户带回列表页）；
 *   - mode 模式入口的服务端契约与模型/思考相同：Kiro 下发 id==='mode' 的
 *     配置项时才出现按钮；面板开关用组件本地状态（ui store 的 PopId
 *     不含 mode，不越权改 store 类型）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useApp } from '../../app/bootstrap.ts';
import {
  CHEV_14,
  EFFORT_ICON,
  MODEL_ICON,
  PERM_ICON,
  SEND_ICON,
  STOP_ICON,
} from '../../assets/icons';
import ConfigPop from './ConfigPop.vue';
import SlashMenu from './SlashMenu.vue';
import { filterSlashCommands, type SlashCommand } from './slashCommands';

/** 模式按钮图标（滑杆）：assets/icons.ts 不在本次写入范围，故内联于本组件。 */
const MODE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></svg>';

const app = useApp();
const { config, conversation, ui } = app;

const text = ref('');
const ta = ref<HTMLTextAreaElement | null>(null);

/**
 * 当前展开的配置面板。
 * 由 ui store 持有：ConversationView 的 Escape 优先级链需要先收起面板
 * （与原实现的 popKey 层级一致），跨组件共享状态才读得到。
 */
const openPop = computed(() => ui.popOpen);

const running = computed(() => conversation.running);
const cancelling = computed(() => conversation.cancelling);

/** 权限档位按钮：只有「完全访问」是橙色警示。 */
const apOption = computed(() => config.autopilotOption);
const apLabel = computed(() => config.currentOptionName(apOption.value) || '—');
const apCalm = computed(() => apOption.value?.currentValue !== 'on');

const modelLabel = computed(() => config.modelLabelOf(config.modelId) || '模型');

/** 模型不支持思考程度时隐藏按钮（而不是禁用）。 */
const effortOption = computed(() => config.effortOption);
const effortLabel = computed(() => config.currentOptionName(effortOption.value) || '思考');

/** 模式入口：Kiro 下发 id==='mode' 的配置项时才出现（同「不支持即隐藏」原则）。 */
const modeOption = computed(() => config.options.find((o) => o.id === 'mode') ?? null);
const modeLabel = computed(
  () => (modeOption.value ? config.optionName(modeOption.value, modeOption.value.currentValue) : null) || '模式'
);

function togglePop(id: 'autopilot' | 'model' | 'effortLevel'): void {
  // 点同一个按钮 = 收起；点另一个 = 换面板，不会两个同时开着
  ui.togglePop(id);
}

function closePop(): void {
  ui.closePop();
}

/**
 * 三个「选择」面板的触发按钮。
 * 面板内按 Escape 关闭后必须把焦点还给触发按钮，否则焦点会掉到 body，
 * 键盘用户丢失当前位置（ARIA menu 的 invoker 契约）。
 */
const apBtn = ref<HTMLButtonElement | null>(null);
const modelBtn = ref<HTMLButtonElement | null>(null);
const effortBtn = ref<HTMLButtonElement | null>(null);
const modeBtn = ref<HTMLButtonElement | null>(null);

/**
 * 面板内 Escape 关闭并把焦点交还触发按钮。
 *
 * 只用于 ConfigPop 的 `close`（仅键盘 Escape 会发出）：点击面板外走
 * onDocClick，那里绝不能抢焦点，否则会把焦点从用户刚点的目标上夺走。
 */
function closePopTo(el: HTMLButtonElement | null): void {
  closePop();
  el?.focus();
}

/** mode 面板的开关状态（组件本地；不与 ui store 的 pops 同住）。 */
const modeOpen = ref(false);

function toggleMode(): void {
  closePop();
  modeOpen.value = !modeOpen.value;
}

function closeMode(): void {
  modeOpen.value = false;
}

/** mode 面板 Escape 关闭：焦点交还触发按钮（见 closePopTo 注释）。 */
function closeModeTo(): void {
  closeMode();
  modeBtn.value?.focus();
}

async function chooseMode(value: string, name: string): Promise<void> {
  const trigger = modeBtn.value;
  closeMode();
  trigger?.focus();
  await app.setConfigOption('mode', value, name);
}

// 思考程度项消失（切到不支持的模型）时，收起可能开着的面板
watch(effortOption, (v) => {
  if (!v) closePop();
});

// 模式项消失时同理；打开任一 ui 面板时收起 mode 面板（互斥，不叠两层）
watch(modeOption, (v) => {
  if (!v) closeMode();
});
watch(openPop, (v) => {
  if (v) closeMode();
});

// ---------- 斜杠命令菜单 ----------

/** Esc 手动收起后保持关闭，直到草稿再次变化。 */
const slashDismissed = ref(false);
const slashIndex = ref(0);

const slashItems = computed<SlashCommand[]>(() => filterSlashCommands(config.commands, text.value));
const slashVisible = computed(() => !slashDismissed.value && slashItems.value.length > 0);
/** 过滤结果变短时高亮不越界。 */
const slashActive = computed(() =>
  Math.max(0, Math.min(slashIndex.value, slashItems.value.length - 1))
);

// 草稿变化 = 重新开始选择；菜单若被 Esc 收起则重新出现
watch(text, () => {
  slashDismissed.value = false;
  slashIndex.value = 0;
});

/** 插入「命令 + 空格」，让用户接着输入参数。 */
function acceptSlash(name: string): void {
  text.value = name + ' ';
  nextTick(() => {
    autoGrow();
    ta.value?.focus();
  });
}

/** 自动高度：先置 auto 再按 scrollHeight 收紧，上限 160px。 */
function autoGrow(): void {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

async function submit(): Promise<void> {
  const value = text.value.trim();
  if (!value || running.value) return;
  text.value = '';
  await nextTick();
  autoGrow();
  await app.send(value);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void submit();
    return;
  }
  if (!slashVisible.value) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    slashIndex.value = (slashActive.value + 1) % slashItems.value.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    slashIndex.value =
      (slashActive.value - 1 + slashItems.value.length) % slashItems.value.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    acceptSlash(slashItems.value[slashActive.value].name);
  } else if (e.key === 'Escape') {
    // 只收起菜单：stopPropagation 防止 ConversationView 的 Escape 链返回列表页
    e.preventDefault();
    e.stopPropagation();
    slashDismissed.value = true;
  }
}

function onSendClick(): void {
  if (running.value) {
    void app.cancel();
    return;
  }
  void submit();
}

async function choose(configId: 'autopilot' | 'model' | 'effortLevel', value: string, name: string): Promise<void> {
  // 面板销毁后浏览器会把焦点丢到 body，Tab 会从文档开头重来。
  // 选择完成把焦点还给对应触发按钮（与 Escape 关闭一致）。
  const trigger = configId === 'autopilot' ? apBtn.value : configId === 'model' ? modelBtn.value : effortBtn.value;
  closePop();
  trigger?.focus();
  await app.setConfigOption(configId, value, name);
}

// 点击面板外收起（面板自身已 stopPropagation）。
// mode 面板用的是组件本地状态，必须一并收起，否则会悬挂在页面上。
function onDocClick(): void {
  closePop();
  closeMode();
  slashDismissed.value = true;
}

document.addEventListener('click', onDocClick);
// 必须在卸载时移除：Composer 随会话页反复挂载/卸载，
// 不移除会累积监听器并泄漏已卸载组件的闭包。
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
});
</script>

<template>
  <div class="conv-composer">
    <div class="composer-inner">
      <div class="composer-box">
        <div class="slash-anchor">
            <p id="composer-hint" class="sr-only">按 Enter 换行，按 Ctrl+Enter 或 Command+Enter 发送</p>
            <textarea
              ref="ta"
              v-model="text"
              rows="1"
              aria-label="输入消息"
              aria-describedby="composer-hint"
              placeholder="继续输入以排队后续修改"
              @input="autoGrow"
              @keydown="onKeydown"
            />
          <SlashMenu
            v-if="slashVisible"
            :items="slashItems"
            :active-index="slashActive"
            @choose="acceptSlash"
          />
        </div>

        <div class="composer-toolbar">
          <div class="composer-left">
            <div v-if="apOption" class="composer-grp">
              <button
                ref="apBtn"
                type="button"
                class="tool-btn mode"
                :class="{ calm: apCalm }"
                aria-label="权限模式"
                aria-haspopup="menu"
                :aria-expanded="openPop === 'autopilot' ? 'true' : 'false'"
                @click.stop="togglePop('autopilot')"
              >
                <span class="i" v-html="PERM_ICON[apOption.currentValue || ''] || ''" />
                <span class="lbl">{{ apLabel }}</span>
                <span class="chev-wrap" v-html="CHEV_14" />
              </button>
              <ConfigPop
                v-if="openPop === 'autopilot'"
                :option="apOption"
                item-class="pop-item-mode"
                panel-class="pop-mode"
                :label-render="true"
                @choose="(v, n) => choose('autopilot', v, n)"
                @close="closePopTo(apBtn)"
              />
            </div>
          </div>

          <div class="composer-right">
            <div class="composer-grp">
              <button
                v-if="config.modelOption"
                ref="modelBtn"
                type="button"
                class="tool-btn model"
                aria-label="选择模型"
                aria-haspopup="menu"
                :aria-expanded="openPop === 'model' ? 'true' : 'false'"
                @click.stop="togglePop('model')"
              >
                <span v-html="MODEL_ICON" />
                <span class="model-dot" aria-hidden="true" />
                <span class="lbl">{{ modelLabel }}</span>
                <span class="chev-wrap" v-html="CHEV_14" />
              </button>

              <button
                v-if="effortOption"
                ref="effortBtn"
                type="button"
                class="tool-btn thought"
                aria-label="思考程度"
                aria-haspopup="listbox"
                :aria-expanded="openPop === 'effortLevel' ? 'true' : 'false'"
                @click.stop="togglePop('effortLevel')"
              >
                <span v-html="EFFORT_ICON" />
                <span class="lbl">{{ effortLabel }}</span>
                <span class="chev-wrap" v-html="CHEV_14" />
              </button>

              <ConfigPop
                v-if="openPop === 'model' && config.modelOption"
                :option="config.modelOption"
                item-class="pop-item-model"
                panel-class="pop-model"
                @choose="(v, n) => choose('model', v, n)"
                @close="closePopTo(modelBtn)"
              />
              <ConfigPop
                v-if="openPop === 'effortLevel' && effortOption"
                :option="effortOption"
                item-class="pop-item-thought"
                panel-class="pop-thought"
                :use-option="true"
                @choose="(v, n) => choose('effortLevel', v, n)"
                @close="closePopTo(effortBtn)"
              />
            </div>

            <!-- 模式入口：与模型/思考同一视觉体系；窄容器只留图标 + aria-label -->
            <!-- 焦点落在触发按钮上时 Escape 也要只收面板，不能冒泡到会话页的返回列表链 -->
            <div v-if="modeOption" class="composer-grp" @keydown.esc.stop.prevent="closeMode">
              <button
                ref="modeBtn"
                type="button"
                class="tool-btn agent-mode"
                aria-label="模式"
                aria-haspopup="menu"
                :aria-expanded="modeOpen ? 'true' : 'false'"
                @click.stop="toggleMode"
              >
                <span class="i" v-html="MODE_ICON" />
                <span class="lbl">{{ modeLabel }}</span>
                <span class="chev-wrap" v-html="CHEV_14" />
              </button>
              <ConfigPop
                v-if="modeOpen && modeOption"
                :option="modeOption"
                item-class="pop-item-thought"
                panel-class="pop-thought"
                :use-option="true"
                @choose="(v, n) => chooseMode(v, n)"
                @close="closeModeTo()"
              />
            </div>

            <button
              type="button"
              class="send-btn"
              :class="{ busy: running }"
              :aria-label="running ? '取消' : '发送'"
              :disabled="cancelling"
              @click="onSendClick"
            >
              <span v-if="cancelling" class="spin" />
              <span v-else-if="running" v-html="STOP_ICON" />
              <span v-else v-html="SEND_ICON" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
