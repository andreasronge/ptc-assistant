(ns survey.workflow
  "Mail metadata survey over time windows; the result is aggregated by
  scripts/survey-aggregate.mjs. Never reads snippets or bodies.")

(defn- returned-value [outcome]
  (if (= :returned (get outcome :outcome))
    (get outcome :value)
    (fail outcome)))

(defn run [input]
  (return
    (returned-value
      (kernel/eval-with
        "google"
        (program (return (survey.google/survey data/params)))
        input))))
