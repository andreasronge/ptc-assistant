(ns digest.rules
  "The week-1 rules layer: pure functions from message metadata to a
  needs_action prediction. No model, no Google calls.")

(def bulk-precedence #{"bulk" "list" "junk"})

(defn- patterns [strings]
  (mapv re-pattern strings))

(defn- matches-any? [compiled text]
  (boolean (and text (some #(re-find % text) compiled))))

(defn compile-rules
  "Compiles the private rules file once per run."
  [rules]
  {"owner" (set (map str/lower-case (get-in rules ["owner" "addresses"])))
   "bulk_senders" (patterns (get-in rules ["bulk" "sender_patterns"]))
   "bulk_categories" (set (get-in rules ["bulk" "gmail_categories"]))
   "important_label" (get-in rules ["important" "gmail_label"] "IMPORTANT")
   "receipt_subjects" (patterns (get-in rules ["receipt" "subject_patterns"]))
   "amount" (re-pattern (get-in rules ["receipt" "amount_pattern"]))
   "vendors" (into {} (map (fn [[address vendor]] [(str/lower-case address) vendor])
                           (get-in rules ["receipt" "vendors"])))})

(defn bulk? [compiled message]
  (let [auto (get message "auto_submitted")]
    (boolean
      (or (true? (get message "list_unsubscribe"))
          (contains? bulk-precedence (get message "precedence"))
          (and auto (not= auto "no"))
          (matches-any? (get compiled "bulk_senders") (get message "from_address"))
          (some (get compiled "bulk_categories") (get message "label_ids"))))))

(defn from-owner? [compiled message]
  (contains? (get compiled "owner") (get message "from_address")))

(defn direct? [compiled message]
  (boolean (some (get compiled "owner") (get message "to_addresses"))))

(defn awaiting-reply?
  "Addressed directly to the owner, and the thread's latest message is not
  the owner's (neither sent by one of their addresses nor labelled SENT)."
  [compiled message thread]
  (and (direct? compiled message)
       (let [latest (last (get thread "messages"))]
         (boolean
           (and latest
                (not (some #{"SENT"} (get latest "label_ids")))
                (not (contains? (get compiled "owner") (get latest "from_address"))))))))

(defn receipt [compiled message]
  (let [vendor (get (get compiled "vendors") (get message "from_address"))
        subject-hit (matches-any? (get compiled "receipt_subjects") (get message "subject"))]
    (when (or vendor subject-hit)
      (let [amount (re-find (get compiled "amount") (or (get message "snippet") ""))]
        {"vendor" vendor
         "amount" (when amount (nth amount 1))
         "currency" (when amount (str/lower-case (nth amount 2)))}))))

(defn classify
  "The needs_action order from SPEC.md, first match wins:
  bulk -> false; person and awaiting reply -> true; IMPORTANT -> true;
  anything else -> false with settled false."
  [compiled correspondents message thread]
  (let [bulk (bulk? compiled message)
        person (contains? correspondents (get message "from_address"))
        awaiting (awaiting-reply? compiled message thread)
        important (boolean (some #{(get compiled "important_label")} (get message "label_ids")))
        [needs-action settled rule]
        (cond
          bulk [false true "bulk"]
          (and person awaiting) [true true "person_awaiting_reply"]
          important [true true "important"]
          :else [false false "none"])]
    {"needs_action" needs-action
     "settled" settled
     "rule" rule
     "bulk" bulk
     "person" person
     "awaiting_reply" awaiting
     "receipt" (receipt compiled message)}))
