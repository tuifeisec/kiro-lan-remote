<script setup lang="ts">
/**
 * 工具调用行。
 *
 * 主行只显示：状态图标 + 工具名 + 操作对象 + 耗时/等待徽标 + 展开箭头。
 * 详细入参与结构化输出默认收起，必须用文本绑定渲染
 * （禁止把模型原文当 HTML 插入 —— 安全边界见 toolModel.ts）。
 *
 * 可展开判据：有入参**或**有结构化输出。无入参但有输出的工具
 * 也要能展开看输出，否则终端/改文件类调用只剩一行标题。
 */
import { computed, ref } from 'vue';
import type { ToolBlock } from '../../domain/messageModel.ts';
import type { ToolContent } from '../../protocol/types.ts';
import { toolCls } from '../../protocol/types';
import { clip, inputFields, toolOp } from '../../domain/toolModel';
import { fmtDuration } from '../../utils/time';
import { STATUS_ICON, TOOL_KIND_ICON } from '../../assets/icons';

const props = defineProps<{ block: ToolBlock; /** 每秒时钟，供运行中工具计时跳动。 */ now?: number }>();

const visual = computed(() => toolCls(props.block.status));
/**
 * 主行图标：运行中用 spinner（动效传达进行中）；结束/失败用**工具类型图标**
 * （读取/编辑/终端/搜索/获取……，对齐官方每类工具有自己的样式），
 * 颜色语义仍由 .wr-tool 的 done/fail 状态类控制。
 */
const icon = computed(() => {
  if (visual.value === 'run') return STATUS_ICON.run;
  return TOOL_KIND_ICON[props.block.toolKind ?? ''] ?? TOOL_KIND_ICON.other;
});
const op = computed(() => toolOp(props.block.rawInput));
/** 展开按钮与详情容器的关联 id（详情仅在展开时进 DOM）。 */
const detailId = computed(() => 'wr-det-' + props.block.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
const fields = computed(() => inputFields(props.block.rawInput));
const failed = computed(() => props.block.status === 'failed');

/**
 * 主行状态小字后缀（对齐官方「图标 + 名称 + · 已完成」）。
 * failed 已有红色「失败」徽标、waiting 有「等待确认」徽标，均不再叠加，
 * 避免同一行出现两个状态词。
 */
const statusSuffix = computed(() => {
  if (failed.value || props.block.waiting) return '';
  if (visual.value === 'run') return '· 进行中';
  if (visual.value === 'done') return '· 已完成';
  return '';
});

/** 有入参或有输出即可展开；两者皆无才是安静行。 */
const canExpand = computed(() => props.block.expandable || props.block.output.length > 0);

const expanded = ref(props.block.expanded);
function toggle(): void {
  if (!canExpand.value) return;
  expanded.value = !expanded.value;
}

/**
 * 主行右侧耗时：
 *   - 已结束 → 定格的 finishedMs；
 *   - 等待权限 → 不报时长（显示「等待确认」徽标，时长无意义）；
 *   - 运行中且有计时基准 → now - startedAt 实时跳动。
 */
const duration = computed(() => {
  const b = props.block;
  if (b.finishedMs != null) return fmtDuration(b.finishedMs);
  if (b.waiting) return null;
  // 实时跳动只属于本页实时帧：重放帧的 startedAt 是 Kiro 帧级时间戳，
  // 绝不能拿本页时钟去减（会算出离谱的天数）。
  if (visual.value === 'run' && !b.replay && b.startedAt != null && props.now) {
    return fmtDuration(props.now - b.startedAt);
  }
  return null;
});

/** diff 行数摘要：按 newText / oldText 的行数计。 */
function lineCount(s: string | undefined): number {
  if (!s) return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}
function addedLines(o: ToolContent): number {
  return lineCount(o.newText);
}
function removedLines(o: ToolContent): number {
  return lineCount(o.oldText);
}
</script>

<template>
  <div class="wr-tool" :class="[visual, { open: expanded, 'stream-in': !block.replay }]">
    <!-- 可展开 → 按钮；无入参且无输出 → 安静行 -->
    <button
      v-if="canExpand"
      type="button"
      class="wr-trig"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="detailId"
      @click="toggle"
    >
      <span class="wr-ico" v-html="icon" />
      <span class="wr-kind">{{ block.title }}</span>
      <span v-if="statusSuffix" class="wr-status">{{ statusSuffix }}</span>
      <span class="wr-body">
        <code v-if="op?.kind === 'cmd'" class="wr-cmd" :title="op.text">{{ op.text }}</code>
        <template v-else-if="op?.kind === 'file'">
          <span class="wr-path" :title="op.full">{{ op.name }}</span>
          <span v-if="op.dir" class="wr-path" :title="op.full">{{ op.dir }}</span>
        </template>
        <span v-if="failed" class="wr-fail" title="执行失败">失败</span>
        <span v-if="block.waiting" class="wr-wait" title="等待权限确认">等待确认</span>
        <span v-else-if="duration" class="wr-dur">{{ duration }}</span>
      </span>
      <span class="wr-chev" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </span>
    </button>

    <div v-else class="wr-row">
      <span class="wr-ico" v-html="icon" />
      <span class="wr-kind">{{ block.title }}</span>
      <span v-if="statusSuffix" class="wr-status">{{ statusSuffix }}</span>
      <span class="wr-body">
        <code v-if="op?.kind === 'cmd'" class="wr-cmd" :title="op.text">{{ op.text }}</code>
        <template v-else-if="op?.kind === 'file'">
          <span class="wr-path" :title="op.full">{{ op.name }}</span>
          <span v-if="op.dir" class="wr-path" :title="op.full">{{ op.dir }}</span>
        </template>
        <span v-if="failed" class="wr-fail" title="执行失败">失败</span>
        <span v-if="block.waiting" class="wr-wait" title="等待权限确认">等待确认</span>
        <span v-else-if="duration" class="wr-dur">{{ duration }}</span>
      </span>
    </div>

    <!-- 详情：入参字段（命令前置 $）+ 服务端结构化输出（text/terminal/diff）。
         一律 {{ }} 文本绑定，禁止 HTML 注入。 -->
    <div v-if="canExpand && expanded" :id="detailId" class="wr-det">
      <div class="wr-det-in">
        <div v-if="block.expandable" class="wr-term">
          <div v-if="!fields.length" class="t-none">该调用没有可展示的参数</div>
          <div v-for="(f, i) in fields" :key="i" class="t-field" :class="{ dim: f.label !== '命令' }">
            <span v-if="f.label === '命令'" class="t-dol">$</span>
            <span v-else class="t-lbl">{{ f.label }}</span>
            <pre>{{ f.value }}</pre>
          </div>
        </div>

        <template v-if="block.output.length">
          <div v-for="(o, i) in block.output" :key="i" class="wr-out">
            <template v-if="o.type === 'diff'">
              <div class="wr-out-head">
                <span class="wr-out-path">{{ o.path || '文件变更' }}</span>
                <span class="wr-out-add">+{{ addedLines(o) }}</span>
                <span class="wr-out-del">−{{ removedLines(o) }}</span>
              </div>
              <pre class="wr-out-pre">{{ clip(o.newText ?? '') }}</pre>
            </template>
            <pre v-else-if="o.type === 'terminal' && o.text" class="wr-out-pre">{{ clip(o.text) }}</pre>
            <div v-else-if="o.type === 'terminal'" class="wr-out-none">终端输出不可用</div>
            <pre v-else-if="o.text" class="wr-out-pre">{{ clip(o.text) }}</pre>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
