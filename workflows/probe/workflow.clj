(ns probe.workflow
  "Phase 0 probe: today's events and one page of message headers through google-mcp.")

(defn- returned-value [outcome]
  (if (= :returned (get outcome :outcome))
    (get outcome :value)
    (fail outcome)))

(defn run [input]
  (let [result (returned-value
                 (kernel/eval-with
                   "google"
                   (program (return (probe.google/probe data/params)))
                   input))]
    (return
      {"event_count" (count (get result "events"))
       "message_count" (count (get result "messages"))
       "events" (get result "events")
       "messages" (get result "messages")})))
