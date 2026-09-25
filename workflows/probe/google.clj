(ns probe.google "Mission-only access to google-mcp's read tools.")

(defn- value! [response]
  (if (= :ok (get response :status)) (get response :value) (fail response)))

(defn- all-events [window]
  (loop [cursor nil
         events []]
    (let [page (value! (tool/google.events (if cursor (assoc window "cursor" cursor) window)))
          events (into events (get page "items"))
          next-cursor (get page "next_cursor")]
      (if next-cursor (recur next-cursor events) events))))

(defn probe [params]
  (let [window {"time_min" (get params "time_min") "time_max" (get params "time_max")}
        window (if (get params "calendar_ids")
                 (assoc window "calendar_ids" (get params "calendar_ids"))
                 window)
        messages (value! (tool/google.search {"query" (get params "query") "limit" (get params "limit")}))]
    {"events" (all-events window)
     "messages" (mapv #(select-keys % ["date" "from_address" "subject" "label_ids" "list_unsubscribe"])
                      (get messages "items"))}))
