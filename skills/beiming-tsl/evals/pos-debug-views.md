---
description: "出调试视图排查墨线问题"
tags: [positive]
covers: [debug-views]
expected_outcome: "本 skill 触发：镜头 look 参数 debug 切 DEBUG_VIEWS（id/edge/line/depth…），用 offscreen render --query 透传，对照 workflow-and-debugging 第 3 节。"
---

有块墨线该出没出，帮我看看：先出一张 edge 视图确认边缘检测，再出一张 line 视图看笔画覆盖，id 视图也来一张检查分组对不对。
