(ns digest.google "Mission-only reads from google-mcp: every page, no classification.")

(defn- value! [response]
  (if (= :ok (get response :status)) (get response :value) (fail response)))

(defn- all-pages
  "Calls `tool` with `arguments`, following next_cursor. Returns the items
  under `key` concatenated, and whether any page was truncated."
  [tool arguments key]
  (loop [cursor nil
         items []
         truncated false]
    (let [page (value! (tool (if cursor (assoc arguments "cursor" cursor) arguments)))
          items (into items (get page key))
          truncated (or truncated (true? (get page "truncated")))]
      (if (get page "next_cursor")
        (recur (get page "next_cursor") items truncated)
        {"items" items "truncated" truncated}))))

(defn- messages [query]
  (all-pages #(tool/google.search %) {"query" query} "items"))

(defn- sent-recipients [windows]
  (reduce (fn [acc window]
            (let [arguments (if (get window "before")
                              {"after" (get window "after") "before" (get window "before")}
                              {"after" (get window "after")})
                  page (all-pages #(tool/google.sent %) arguments "addresses")]
              {"items" (into (get acc "items") (get page "items"))
               "truncated" (or (get acc "truncated") (get page "truncated"))}))
          {"items" [] "truncated" false}
          windows))

(defn- threads [ids]
  (reduce (fn [acc batch]
            (into acc (get (value! (tool/google.threads {"thread_ids" (vec batch)})) "items")))
          []
          (partition-all 50 ids)))

(defn- events [window calendar-ids]
  (get (all-pages #(tool/google.events %)
                  {"time_min" (get window "time_min")
                   "time_max" (get window "time_max")
                   "calendar_ids" calendar-ids}
                  "items")
       "items"))

(defn fetch
  "Everything the digest needs from Google. Threads are fetched only for
  messages addressed directly to one of the owner's addresses."
  [params]
  (let [owner (set (get params "owner_addresses"))
        mail (messages (get params "query"))
        direct (filter (fn [m] (some owner (get m "to_addresses"))) (get mail "items"))
        sent (sent-recipients (get params "sent_windows"))]
    {"messages" (get mail "items")
     "messages_truncated" (get mail "truncated")
     "sent_recipients" (vec (distinct (get sent "items")))
     "sent_truncated" (get sent "truncated")
     "threads" (threads (distinct (map #(get % "thread_id") direct)))
     "events" (events (get params "calendar_window") (get params "calendar_ids"))}))
