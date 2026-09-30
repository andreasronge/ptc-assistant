(ns probe.decision
  "Sends message metadata to the decision provider in batches and returns the
  raw answers. It never thresholds; scripts/score-decision.mjs does.")

(defn- question-id [prefix id] (str prefix "_" id))

(defn- questions [messages categories]
  (into {}
        (mapcat (fn [m]
                  (let [id (get m "id")]
                    [[(question-id "A" id)
                      {"type" "boolean"
                       "instructions" (str "Does the owner need to act on message " id " (reply, pay, confirm, decide, collect, or review something)? Judge from sender, subject, labels and flags only.")
                       "criteria" {"true" "The owner must do something about this message."
                                   "false" "Informational, automated, or already handled; nothing to do."}}]
                     [(question-id "C" id)
                      {"type" "choice"
                       "instructions" (str "Which category is this message? Message id " id ".")
                       "criteria" categories}]]))
                messages)))

(defn- ask [messages categories]
  (let [response (decision/request
                   {"state" {"messages" (mapv #(select-keys % ["id" "from_address" "subject" "label_ids" "list_unsubscribe"])
                                              messages)}
                    "questions" (questions messages categories)})]
    (if (= :error (get response :status))
      (fail response)
      response)))

(defn run [input]
  (let [categories (get input "categories")
        batches (partition-all (get input "batch_size") (get input "messages"))
        responses (mapv (fn [batch] (ask (vec batch) categories)) batches)]
    (return
      {"models" (vec (distinct (map #(get % "model") responses)))
       "usage" (mapv #(get % "usage") responses)
       "answers" (apply merge (map #(get % "answers") responses))})))
