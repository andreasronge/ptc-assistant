(ns survey.google "Mission-only reads: message metadata for a list of time windows. No snippets, no bodies.")

(defn- value! [response]
  (if (= :ok (get response :status)) (get response :value) (fail response)))

(defn- all-pages [query]
  (loop [cursor nil
         items []
         truncated false]
    (let [page (value! (tool/google.search (if cursor {"query" query "cursor" cursor} {"query" query "limit" 100})))
          items (into items (get page "items"))
          truncated (or truncated (true? (get page "truncated")))]
      (if (get page "next_cursor")
        (recur (get page "next_cursor") items truncated)
        {"items" items "truncated" truncated}))))

(defn- trim [m]
  (assoc (select-keys m ["date" "from" "from_address" "subject" "label_ids" "list_unsubscribe"])
         "to_count" (count (get m "to_addresses"))))

(defn survey [params]
  (let [base (get params "query")
        windows (get params "windows")
        results (mapv (fn [w]
                        (let [page (all-pages (str base " after:" (get w "after") " before:" (get w "before")))]
                          {"window" w
                           "count" (count (get page "items"))
                           "truncated" (get page "truncated")
                           "messages" (mapv trim (get page "items"))}))
                      windows)]
    {"windows" (mapv #(select-keys % ["window" "count" "truncated"]) results)
     "messages" (vec (mapcat #(get % "messages") results))}))
