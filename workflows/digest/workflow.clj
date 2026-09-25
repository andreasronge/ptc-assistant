(ns digest.workflow
  "Daily digest, rules layer only. Input is assembled by scripts/digest.sh;
  the result holds the digest, the predictions, and the next state.")

(defn- returned-value [outcome]
  (if (= :returned (get outcome :outcome))
    (get outcome :value)
    (fail outcome)))

(defn- fetch [params]
  (returned-value
    (kernel/eval-with "google" (program (return (digest.google/fetch data/params))) params)))

(defn- day-of [event]
  (let [start (or (get event "start") "")]
    (if (>= (count start) 10) (subs start 0 10) start)))

(defn- overlaps
  "Pairs of timed, not-declined events on the same day that overlap. Starts
  and ends share the Stockholm offset, so they compare as strings."
  [events]
  (let [timed (filterv #(and (not (get % "all_day")) (not= "declined" (get % "my_response"))) events)]
    (vec (for [i (range (count timed))
               j (range (inc i) (count timed))
               :let [a (nth timed i) b (nth timed j)]
               :when (and (= (day-of a) (day-of b))
                          (neg? (compare (get a "start") (get b "end")))
                          (neg? (compare (get b "start") (get a "end"))))]
           [(get a "id") (get b "id")]))))

(defn- calendar-view [events day owner correspondents]
  (->> events
       (filter #(= day (day-of %)))
       (sort-by #(get % "start"))
       (mapv (fn [event]
               (let [others (->> (get event "attendees")
                                 (remove #(get % "self"))
                                 (map #(get % "email"))
                                 (remove owner))]
                 {"id" (get event "id")
                  "start" (get event "start")
                  "end" (get event "end")
                  "all_day" (get event "all_day")
                  "title" (get event "title")
                  "location" (get event "location")
                  "my_response" (get event "my_response")
                  "with_others" (get event "with_others")
                  "has_agenda" (get event "has_agenda")
                  "new_people" (vec (remove correspondents others))})))))

(defn- digest-entry [message verdict]
  (merge (select-keys message ["id" "thread_id" "date" "from" "from_address" "subject" "snippet" "label_ids"])
         (select-keys verdict ["needs_action" "settled" "rule" "person" "awaiting_reply" "receipt"])))

(defn run [input]
  (let [compiled (digest.rules/compile-rules (get input "rules"))
        owner (get compiled "owner")
        raw (fetch {"query" (get input "query")
                    "owner_addresses" (vec owner)
                    "sent_windows" (get input "sent_windows")
                    "calendar_window" (get input "calendar_window")
                    "calendar_ids" (get input "calendar_ids")})
        correspondents (set (remove owner (concat (get input "correspondents") (get raw "sent_recipients"))))
        seen (set (get input "seen_message_ids"))
        threads (into {} (map (fn [t] [(get t "thread_id") t]) (get raw "threads")))
        messages (->> (get raw "messages")
                      (remove #(contains? seen (get % "id")))
                      (remove #(digest.rules/from-owner? compiled %))
                      (sort-by #(get % "date"))
                      reverse)
        judged (mapv (fn [m] [m (digest.rules/classify compiled correspondents m (get threads (get m "thread_id")))])
                     messages)
        entries (mapv (fn [[m v]] (digest-entry m v)) judged)
        bulk (filterv #(= "bulk" (get % "rule")) entries)
        days (get input "days")
        events (get raw "events")]
    (return
      {"date" (first days)
       "generated_at" (get input "now")
       "window" (get input "window")
       "calendar" {"days" (mapv (fn [day] {"date" day
                                           "events" (calendar-view events day owner correspondents)})
                                days)
                   "overlaps" (overlaps events)}
       "needs_action" (filterv #(get % "needs_action") entries)
       "unsettled" (filterv #(not (get % "settled")) entries)
       "bulk" (->> bulk
                   (group-by #(get % "from_address"))
                   (map (fn [[sender items]] {"sender" sender
                                              "name" (get (first items) "from")
                                              "count" (count items)}))
                   (sort-by #(- (get % "count")))
                   vec)
       "receipts" (filterv #(get % "receipt") entries)
       "counts" {"messages" (count entries)
                 "needs_action" (count (filter #(get % "needs_action") entries))
                 "unsettled" (count (remove #(get % "settled") entries))
                 "bulk" (count bulk)
                 "events" (count events)}
       "warnings" (vec (concat (when (get raw "messages_truncated") ["mail window held more than 500 messages"])
                               (when (get raw "sent_truncated") ["a sent-mail window held more than 500 messages"])))
       "predictions" (mapv (fn [[m v]] {"message_id" (get m "id")
                                        "thread_id" (get m "thread_id")
                                        "received_at" (get m "date")
                                        "layer" "rules"
                                        "needs_action" (get v "needs_action")
                                        "settled" (get v "settled")
                                        "rule" (get v "rule")
                                        "probability" nil})
                           judged)
       "state" {"correspondents" (vec (sort (vec correspondents)))
                "message_ids" (mapv #(get % "id") (get raw "messages"))}})))
