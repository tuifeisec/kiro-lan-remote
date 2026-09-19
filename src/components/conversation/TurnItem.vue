<script setup lang="ts">
/**
 * 一个 Agent 回合：用户消息 → 工作过程（可折叠）→ 最终回答 → 操作条。
 *
 * 三个层级必须可辨认（开发文档 8.7.3）：
 *   过程可收起、工具详情可单独展开、最终答案不被折叠面板遮蔽。
 */
import type { Turn } from '../../domain/messageModel.ts';
import { ref } from 'vue';
import UserMessage from './UserMessage.vue';
import WorkProcess from './WorkProcess.vue';
import AssistantMessage from './AssistantMessage.vue';
import MessageActions from './MessageActions.vue';

defineProps<{ turn: Turn; now?: number }>();

/**
 * 最终回答组件实例。
 * 复制按钮需要的是**渲染后的纯文本**，原实现是 `curTurn.querySelectorAll('.assistant .md')`
 * 取 innerText；这里通过组件暴露的 text 取得同一份内容，不直接操作 DOM。
 */
const answer = ref<InstanceType<typeof AssistantMessage> | null>(null);
</script>

<template>
  <div class="turn">
    <UserMessage v-if="turn.userMessage" :message="turn.userMessage" :stream-in="!turn.replay" />

    <!-- 工作过程：仅当本回合出现过工具调用或已建立分割线 -->
    <WorkProcess v-if="turn.workVisible" :turn="turn" :now="now" />

    <!-- 最终回答：始终在折叠面板之外直接可见 -->
    <AssistantMessage v-if="turn.answer" ref="answer" :block="turn.answer" />

    <MessageActions
      v-if="turn.actionsVisible"
      :turn="turn"
      :get-answer-text="() => answer?.getText() ?? ''"
    />
  </div>
</template>
